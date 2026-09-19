import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import db from '../database.js';
import { authRequired, authOptional } from '../middleware/auth.js';
import { signShareToken } from './gate.js';
import { UPLOAD_DIR } from '../config.js';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * 落盘时只用随机名 + 占位扩展名，真实扩展名等**读完文件头**再补。
 *
 * 不直接用客户端给的扩展名的原因见 sniffImageType 的注释：那是攻击者
 * 完全可控的输入，一旦落成 .html/.svg 就会被静态服务当作可执行文档返回。
 */
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, _file, cb) => cb(null, `${uuidv4()}.upload`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  // 这里刻意**不**按 file.mimetype 过滤：那个值来自请求头，是客户端说了算的，
  // 拿它当准入条件既拦不住伪装（把 HTML 声明成 image/png），又会误伤
  // （真实图片被某些客户端标成 application/octet-stream）。准入判断统一交给
  // 下面的文件头检测，那里看的是字节本身。
});

/**
 * 包一层 multer，把它抛出的错误转成 JSON。
 *
 * 为什么必须包：multer 出错时是 next(err)，走的是 Express 的**默认错误处理**，
 * 返回的是一整页 HTML。前端 `await res.json()` 会直接抛
 * 「Unexpected token '<'」，用户看到一个和真实原因毫无关系的报错。
 * 尺寸超限、字段名不对这类最常见的失败，必须让前端拿到可读的中文原因。
 */
function uploadFiles(req, res, next) {
  upload.array('files')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '单张图片不能超过 50MB' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: '文件字段名必须是 files' });
    }
    return res.status(400).json({ error: err.message || '图片上传失败' });
  });
}

// ---------------------------------------------------------------------------
// 真实类型检测（只看字节）
// ---------------------------------------------------------------------------

const IMAGE_TYPES = {
  jpeg: { ext: '.jpg', mime: 'image/jpeg', label: 'JPG' },
  png: { ext: '.png', mime: 'image/png', label: 'PNG' },
  gif: { ext: '.gif', mime: 'image/gif', label: 'GIF' },
  webp: { ext: '.webp', mime: 'image/webp', label: 'WebP' },
  bmp: { ext: '.bmp', mime: 'image/bmp', label: 'BMP' },
  avif: { ext: '.avif', mime: 'image/avif', label: 'AVIF' },
};

/**
 * 只认字节的文件类型识别。
 *
 * 为什么不能信 file.mimetype / 文件名后缀：两者都直接来自请求，
 * 攻击者把一段 HTML 声明成 image/png、命名成 evil.html 就能穿过原先的
 * `mimetype.startsWith('image/')` 检查，并因为落盘时沿用了原始后缀而
 * 变成 uploads/xxxx.html —— express.static 会按 text/html 返回它，
 * 脚本于是在**本站同源**下执行，可以顺手把站点访问令牌（Cookie 里那份
 * 为了 <img> 能加载而特意设为非 httpOnly）和 localStorage 里的登录态一起带走。
 *
 * 返回 null 表示「不是我们支持的图片」，调用方必须拒绝并删掉文件。
 */
function sniffImageType(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, read);
  } catch {
    return null;
  }
  if (head.length < 12) return null;

  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return IMAGE_TYPES.jpeg;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return IMAGE_TYPES.png;
  // GIF87a / GIF89a
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return IMAGE_TYPES.gif;
  // RIFF....WEBP
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return IMAGE_TYPES.webp;
  // BMP: 42 4D
  if (head[0] === 0x42 && head[1] === 0x4d) return IMAGE_TYPES.bmp;
  // ISO-BMFF：....ftyp + brand
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    // HEIC/HEIF 也走这个容器，但浏览器普遍渲染不了，收下来只会得到一堆打不开的图，
    // 所以只放行真正能显示的 AVIF。
    if (brand === 'avif' || brand === 'avis') return IMAGE_TYPES.avif;
    return null;
  }
  return null;
}

const SUPPORTED_LABEL = Object.values(IMAGE_TYPES).map((t) => t.label).join('/');

/**
 * 原始文件名解码。
 *
 * busboy 默认按 latin1 解 multipart 的文件名，中文名会变成乱码，
 * 所以要把这串 latin1 再按 utf8 还原一次；但如果客户端本来就发的 UTF-8
 * （某些版本/客户端会），再转一次反而会得到一堆  替换字符 ——
 * 因此只有转换结果合法时才采用。
 */
function decodeOriginalName(raw) {
  const name = String(raw || '');
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) return decoded;
  } catch { /* 保持原值 */ }
  return name;
}

// 纯 JS 图片尺寸解析（零依赖）
function getImageDimensions(filepath) {
  try {
    const fd = fs.openSync(filepath, 'r');
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);

    // JPEG
    if (head[0] === 0xFF && head[1] === 0xD8) {
      let i = 2;
      while (i < head.length - 9) {
        if (head[i] !== 0xFF) break;
        const marker = head[i + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          return { width: head.readUInt16BE(i + 7), height: head.readUInt16BE(i + 5) };
        }
        i += 2 + head.readUInt16BE(i + 2);
      }
    }

    // PNG
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }

    // GIF
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }

    // WebP
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
        head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50 &&
        head[12] === 0x56 && head[13] === 0x50 && head[14] === 0x38) {
      // VP8X
      if (head[15] === 0x58) return { width: (head.readUInt32LE(24) & 0xFFFFFF) + 1, height: (head.readUInt32LE(27) & 0xFFFFFF) + 1 };
      // VP8L
      if (head[15] === 0x4C) {
        const b0 = head[21], b1 = head[22], b2 = head[23], b3 = head[24];
        return { width: ((b1 & 0x3F) << 8 | b0) + 1, height: ((b3 & 0xF) << 10 | b2 << 2 | (b1 & 0xC0) >> 6) + 1 };
      }
    }
  } catch { /* ignore */ }
  return { width: 800, height: 600 };
}

const router = Router();

/** 存储用文件名 / 标题的长度上限，避免异常长的名字把库撑大 */
const MAX_NAME_LENGTH = 255;

/**
 * 给照片补上 share_token。
 *
 * 为什么由服务端下发而不是前端自己拼：分享令牌必须由掌握 JWT 密钥的服务端签发，
 * 前端只能拿到「结果」。前端拿不到令牌，整站加密时分享链接就点不开。
 */
function withShareToken(photo) {
  if (!photo) return photo;
  return { ...photo, share_token: signShareToken(photo.id) };
}

function withShareTokens(photos) {
  return (photos || []).map(withShareToken);
}

/**
 * 标签归一化：接受字符串（逗号/分号/空白分隔，或 JSON 数组文本）或数组。
 * 去空、去重、去引号、截断长度，最多 20 个 —— 结果直接 JSON.stringify 存库。
 */
function normalizeTags(raw) {
  let arr = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        arr = Array.isArray(parsed) ? parsed : [text];
      } catch {
        arr = text.split(/[,，;；]+/);
      }
    } else {
      arr = text.split(/[,，;；\s]+/);
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const value = String(item == null ? '' : item)
      .replace(/["'\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 20) break;
  }
  return out;
}

/** 把 LIKE 通配符转义，避免标签/关键词里的 % _ 被当作模糊匹配（配套 ESCAPE '\' 使用） */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * 查询参数解析。
 *
 * 为什么不能直接 `+page`：`/api/photos?page=abc` 会得到 NaN，
 * 传给 SQLite 的 LIMIT/OFFSET 就是 NaN，驱动直接抛
 * 「datatype mismatch」→ 500。而 limit 为负数时 SQLite 把
 * `LIMIT -5` 理解成「不限量」，一次请求就能把整库读出来。
 */
function toBoundedInt(value, fallback, { min, max }) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

router.get('/', authOptional, (req, res) => {
  const { search, tag, author } = req.query;
  const page = toBoundedInt(req.query.page, 1, { min: 1, max: 100000 });
  const limit = toBoundedInt(req.query.limit, 20, { min: 1, max: 100 });
  const offset = (page - 1) * limit;

  let where = '';
  const params = [];
  const conditions = [];

  // 三个 LIKE 都必须带 ESCAPE：escapeLike 把 % _ 转义成了 \% \_，
  // 但如果不声明转义字符，反斜杠只会被当成普通字符，搜索「100%」这类
  // 关键词就会永远搜不到东西。
  if (search) {
    conditions.push("(p.title LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')");
    const q = `%${escapeLike(search)}%`;
    params.push(q, q, q);
  }
  // 标签以 JSON 数组文本落库（如 ["风景","人像"]），用精确匹配 "标签" 避免子串误命中
  if (tag) {
    conditions.push("p.tags LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(tag)}"%`);
  }
  if (author) {
    conditions.push('u.username = ?');
    params.push(String(author));
  }

  if (conditions.length > 0) {
    where = 'WHERE ' + conditions.join(' AND ');
  }

  // 收藏状态：userId 一律走占位符绑定。原先是把 userId 直接插进 SQL 文本的
  // （`l.user_id = '${userId}'`），虽然这个值来自数据库里的主键、当前不可控，
  // 但只要上游任何一处改了取法，这里立刻变成注入口，没理由留着。
  const userId = req.user?.id;
  const joinParams = [];
  let photoLikeJoin = '';
  let likedExpr = '0 as is_liked';
  if (userId) {
    photoLikeJoin = 'LEFT JOIN likes l ON p.id = l.photo_id AND l.user_id = ?';
    likedExpr = 'CASE WHEN l.user_id IS NOT NULL THEN 1 ELSE 0 END as is_liked';
    joinParams.push(userId);
  }

  const count = db.prepare(`
    SELECT COUNT(*) as total FROM photos p
    JOIN users u ON p.uploader_id = u.id
    ${where}
  `).get(...params);

  const photos = db.prepare(`
    SELECT p.*, u.username as uploader_name,
      ${likedExpr}
    FROM photos p
    JOIN users u ON p.uploader_id = u.id
    ${photoLikeJoin}
    ${where}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...joinParams, ...params, limit, offset);

  res.json({
    photos: withShareTokens(photos),
    total: count.total,
    page,
    limit,
    totalPages: Math.ceil(count.total / limit),
  });
});

router.get('/mine', authRequired, (req, res) => {
  const photos = db.prepare(`
    SELECT p.*, u.username as uploader_name
    FROM photos p
    JOIN users u ON p.uploader_id = u.id
    WHERE p.uploader_id = ?
    ORDER BY p.created_at DESC, p.id DESC
  `).all(req.user.id);

  const likesSub = db.prepare('SELECT photo_id FROM likes WHERE user_id = ?').all(req.user.id);
  const likedIds = new Set(likesSub.map(l => l.photo_id));

  const result = photos.map(p => ({ ...p, is_liked: likedIds.has(p.id) ? 1 : 0 }));
  res.json({ photos: withShareTokens(result) });
});

/**
 * 全部标签 / 全部作者（供页面顶部的筛选按钮使用）。
 * 注意：必须定义在 `/:id` 之前，否则 "facets" 会被当成图片 id。
 */
router.get('/facets', authOptional, (_req, res) => {
  const rows = db.prepare(`
    SELECT p.tags AS tags, u.username AS uploader_name
    FROM photos p
    JOIN users u ON p.uploader_id = u.id
  `).all();

  const tagCount = new Map();
  const authorCount = new Map();

  for (const row of rows) {
    let list = [];
    try {
      const parsed = JSON.parse(row.tags);
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* 脏数据忽略 */ }
    for (const t of list) {
      const name = String(t == null ? '' : t).trim();
      if (!name) continue;
      tagCount.set(name, (tagCount.get(name) || 0) + 1);
    }
    const author = String(row.uploader_name == null ? '' : row.uploader_name).trim();
    if (author) authorCount.set(author, (authorCount.get(author) || 0) + 1);
  }

  const toList = (map) => Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));

  res.json({ tags: toList(tagCount), authors: toList(authorCount) });
});

router.get('/:id', authOptional, (req, res) => {
  const userId = req.user?.id;
  const photo = userId
    ? db.prepare(`
        SELECT p.*, u.username as uploader_name,
          (SELECT COUNT(*) FROM likes WHERE photo_id = p.id AND user_id = ?) as is_liked
        FROM photos p
        JOIN users u ON p.uploader_id = u.id
        WHERE p.id = ?
      `).get(userId, req.params.id)
    : db.prepare(`
        SELECT p.*, u.username as uploader_name, 0 as is_liked
        FROM photos p
        JOIN users u ON p.uploader_id = u.id
        WHERE p.id = ?
      `).get(req.params.id);

  if (!photo) return res.status(404).json({ error: '图片不存在' });
  res.json({ photo: withShareToken(photo) });
});

router.post('/', authRequired, uploadFiles, (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '请选择图片文件' });
  }

  // 先按字节把整批文件验一遍：类型不对就整批拒绝，不留「一半成功」的中间态。
  const invalid = [];
  const accepted = [];
  for (const file of req.files) {
    const type = sniffImageType(file.path);
    if (!type) {
      invalid.push(decodeOriginalName(file.originalname) || '未命名文件');
      continue;
    }
    // 扩展名由检测结果决定，与客户端给的文件名彻底脱钩
    const finalName = `${path.parse(file.filename).name}${type.ext}`;
    try {
      fs.renameSync(path.join(UPLOAD_DIR, file.filename), path.join(UPLOAD_DIR, finalName));
    } catch (e) {
      console.warn('[photos] 重命名上传文件失败:', e.message);
      invalid.push(decodeOriginalName(file.originalname) || '未命名文件');
      continue;
    }
    file.filename = finalName;
    file.detectedMime = type.mime;
    accepted.push(file);
  }

  if (invalid.length > 0) {
    // 注意 file.filename 已被改写成最终名，因此这里删的就是真正落盘的那些文件
    for (const f of req.files) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f.filename)); } catch { /* ignore */ }
    }
    console.warn(`[photos] 拒绝了 ${invalid.length} 个非图片文件: ${invalid.join('、')}`);
    return res.status(400).json({
      error: `以下文件不是有效的图片（支持 ${SUPPORTED_LABEL}）：${invalid.join('、')}`,
    });
  }

  // 标签可选：不传 / 传空 => 存空数组
  const tagsJson = JSON.stringify(normalizeTags(req.body && req.body.tags));

  const photos = [];
  const insert = db.prepare(`
    INSERT INTO photos (id, filename, original_name, title, description, tags, size, mime_type, width, height, uploader_id)
    VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((files) => {
    for (const file of files) {
      const id = uuidv4();
      const originalName = decodeOriginalName(file.originalname).slice(0, MAX_NAME_LENGTH);
      const title = originalName.replace(/\.[^/.]+$/, '').slice(0, MAX_NAME_LENGTH);
      const filepath = path.join(UPLOAD_DIR, file.filename);
      const dims = getImageDimensions(filepath);
      insert.run(id, file.filename, originalName, title, tagsJson, file.size, file.detectedMime, dims.width, dims.height, req.user.id);
      photos.push({
        id, filename: file.filename, original_name: originalName,
        title, description: '', tags: tagsJson, size: file.size,
        mime_type: file.detectedMime, width: dims.width, height: dims.height,
        uploader_id: req.user.id, uploader_name: req.user.username,
        likes_count: 0, downloads_count: 0, is_liked: 0,
        created_at: new Date().toISOString(),
      });
    }
  });

  try {
    insertMany(accepted);
  } catch (e) {
    // 落库失败必须把已经写到磁盘的文件清掉，否则 uploads 里会堆一堆没人认领的孤儿文件
    for (const f of accepted) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f.filename)); } catch { /* ignore */ }
    }
    console.error(`[photos] 入库失败（tags=${tagsJson}，文件数=${accepted.length}）:`, (e && e.stack) || e);
    return res.status(500).json({ error: `保存图片信息失败：${(e && e.message) || e}` });
  }

  res.status(201).json({ photos: withShareTokens(photos) });
});

router.post('/:id/like', authRequired, (req, res) => {
  const { id } = req.params;
  const photo = db.prepare('SELECT id FROM photos WHERE id = ?').get(id);
  if (!photo) return res.status(404).json({ error: '图片不存在' });

  const existing = db.prepare('SELECT * FROM likes WHERE user_id = ? AND photo_id = ?').get(req.user.id, id);

  if (existing) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND photo_id = ?').run(req.user.id, id);
    db.prepare('UPDATE photos SET likes_count = MAX(0, likes_count - 1) WHERE id = ?').run(id);
    const updated = db.prepare('SELECT likes_count FROM photos WHERE id = ?').get(id);
    res.json({ liked: false, likes_count: updated.likes_count });
  } else {
    db.prepare('INSERT INTO likes (user_id, photo_id) VALUES (?, ?)').run(req.user.id, id);
    db.prepare('UPDATE photos SET likes_count = likes_count + 1 WHERE id = ?').run(id);
    const updated = db.prepare('SELECT likes_count FROM photos WHERE id = ?').get(id);
    res.json({ liked: true, likes_count: updated.likes_count });
  }
});

router.post('/:id/download', authOptional, (req, res) => {
  const { id } = req.params;
  const photo = db.prepare('SELECT downloads_count FROM photos WHERE id = ?').get(id);
  if (photo) {
    db.prepare('UPDATE photos SET downloads_count = downloads_count + 1 WHERE id = ?').run(id);
  }
  res.json({ ok: true });
});

router.delete('/:id', authRequired, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: '图片不存在' });
  if (photo.uploader_id !== req.user.id) return res.status(403).json({ error: '无权删除此图片' });

  const filepath = path.join(UPLOAD_DIR, photo.filename);
  try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch { /* ignore */ }

  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
