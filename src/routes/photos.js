import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../database.js';
import { authRequired, authOptional } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('仅支持图片格式'), false);
  },
});

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

router.get('/', authOptional, (req, res) => {
  const { search, year, month, day, page = 1, limit = 50 } = req.query;
  const offset = (Math.max(1, +page) - 1) * Math.min(100, +limit);
  const sqlLimit = Math.min(100, +limit);

  let where = '';
  const params = [];
  const conditions = [];

  if (search) {
    conditions.push('(p.title LIKE ? OR p.tags LIKE ? OR u.username LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  if (year) {
    conditions.push(`p.created_at LIKE '${year}-%'`);
  }
  if (year && month) {
    conditions.push(`p.created_at LIKE '${year}-${String(month).padStart(2, '0')}-%'`);
  }
  if (year && month && day) {
    conditions.push(`p.created_at LIKE '${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}%'`);
  }

  if (conditions.length > 0) {
    where = 'WHERE ' + conditions.join(' AND ');
  }

  const userId = req.user?.id;
  const photoLikeJoin = userId
    ? `LEFT JOIN likes l ON p.id = l.photo_id AND l.user_id = '${userId}'`
    : '';

  const count = db.prepare(`
    SELECT COUNT(*) as total FROM photos p
    JOIN users u ON p.uploader_id = u.id
    ${where}
  `).get(...params);

  const photos = db.prepare(`
    SELECT p.*, u.username as uploader_name,
      ${userId ? `CASE WHEN l.user_id IS NOT NULL THEN 1 ELSE 0 END as is_liked` : '0 as is_liked'}
    FROM photos p
    JOIN users u ON p.uploader_id = u.id
    ${photoLikeJoin}
    ${where}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, sqlLimit, offset);

  res.json({
    photos,
    total: count.total,
    page: +page,
    totalPages: Math.ceil(count.total / sqlLimit),
  });
});

router.get('/mine', authRequired, (req, res) => {
  const photos = db.prepare(`
    SELECT p.*, u.username as uploader_name
    FROM photos p
    JOIN users u ON p.uploader_id = u.id
    WHERE p.uploader_id = ?
    ORDER BY p.created_at DESC
  `).all(req.user.id);

  const likesSub = db.prepare('SELECT photo_id FROM likes WHERE user_id = ?').all(req.user.id);
  const likedIds = new Set(likesSub.map(l => l.photo_id));

  const result = photos.map(p => ({ ...p, is_liked: likedIds.has(p.id) ? 1 : 0 }));
  res.json({ photos: result });
});

router.get('/:id', authOptional, (req, res) => {
  const userId = req.user?.id;
  const photo = db.prepare(`
    SELECT p.*, u.username as uploader_name,
      ${userId ? `(SELECT COUNT(*) FROM likes WHERE photo_id = p.id AND user_id = '${userId}') as is_liked` : '0 as is_liked'}
    FROM photos p
    JOIN users u ON p.uploader_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!photo) return res.status(404).json({ error: '图片不存在' });
  res.json({ photo });
});

router.post('/', authRequired, upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '请选择图片文件' });
  }

  const photos = [];
  const insert = db.prepare(`
    INSERT INTO photos (id, filename, original_name, title, description, tags, size, mime_type, width, height, uploader_id)
    VALUES (?, ?, ?, ?, '', '[]', ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((files) => {
    for (const file of files) {
      const id = uuidv4();
      let originalName = file.originalname;
      try {
        originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      } catch { /* 保持原值 */ }
      const title = originalName.replace(/\.[^/.]+$/, '');
      const filepath = path.join(UPLOAD_DIR, file.filename);
      const dims = getImageDimensions(filepath);
      insert.run(id, file.filename, originalName, title, file.size, file.mimetype, dims.width, dims.height, req.user.id);
      photos.push({
        id, filename: file.filename, original_name: originalName,
        title, description: '', tags: '[]', size: file.size,
        mime_type: file.mimetype, width: dims.width, height: dims.height,
        uploader_id: req.user.id, uploader_name: req.user.username,
        likes_count: 0, downloads_count: 0, is_liked: 0,
        created_at: new Date().toISOString(),
      });
    }
  });

  insertMany(req.files);
  res.status(201).json({ photos });
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
