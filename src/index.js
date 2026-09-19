import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import db from './database.js';
import { PORT, DIST_DIR, UPLOAD_DIR, TRUST_PROXY } from './config.js';
import authRoutes from './routes/auth.js';
import photoRoutes from './routes/photos.js';
import settingsRoutes from './routes/settings.js';
import adminRoutes from './routes/admin.js';
import { isThumbName, resolveThumbRequest, thumbnailStatus } from './thumbnails.js';
import gateRoutes, {
  gateGuard,
  gateGuardAllowAdmin,
  gateGuardUploads,
  gateGuardAssets,
  isGateEnabled,
  isGateTokenValid,
  gatePublicInfo,
  tokenFromRequest,
  isShareTokenValidFor,
} from './routes/gate.js';

const app = express();

app.disable('etag');
// 告诉全世界「这是 Express」没有任何好处，只方便别人按版本找漏洞
app.disable('x-powered-by');
// 反向代理支持：默认关闭，由部署者按实际情况用 TRUST_PROXY 打开（详见 config.js）
if (TRUST_PROXY !== false) app.set('trust proxy', TRUST_PROXY);
app.use(cors({ exposedHeaders: ['X-Site-Required'] }));
app.use(express.json());

/**
 * 基础安全响应头。
 * 放在最前面，保证页面、接口、图片都带上。
 * 重点是把 MIME 嗅探关掉：否则浏览器可能无视我们声明的 Content-Type，
 * 把 uploads 里某个内容可疑的文件「猜」成 HTML 来执行。
 */
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

/**
 * 分享链接豁免：`/share/<photoId>?t=<shareToken>` 这类请求即便在整站加密状态下也放行。
 *
 * 放在所有闸门之前，并打上 req.__gatePassed，让后面的守卫跳过。
 * 注意只豁免「分享页本身」，照片数据仍由分享页服务端渲染，不额外开放 API。
 */
app.use('/share', (req, res, next) => {
  req.__gatePassed = true;
  next();
});

// ---------------------------------------------------------------------------
// 全局访问密码闸门
// 启用后：除入口页与 /api/gate/*（解锁接口本身）之外，一切请求都必须携带有效访问令牌。
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (isGateEnabled()) res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// 解锁相关接口必须放在闸门之前，否则无法换取令牌
app.use('/api/gate', gateRoutes);

// 「管理访问密码」接口放行管理员：否则会出现「管理员没解锁 → 改不了密码 / 关不掉闸门」的死锁。
// 注意要挂在于 /api 的通用闸门之前，才能先于它命中。
app.use('/api/admin/site-password', gateGuardAllowAdmin);

app.use('/api', gateGuard);

app.use((_req, res, next) => {
  const origEnd = res.end;
  res.end = function (...args) {
    // 只在真的改过数据时才落盘。以前是无条件保存，于是「登录」这种纯读的
    // POST 也会把整库导出并写一遍磁盘，白白拖慢一次本来几毫秒就能完成的请求。
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(_req.method) && db.isDirty()) {
      db.save();
    }
    return origEnd.apply(this, args);
  };
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);

/**
 * /api 下的兜底错误处理：任何未被路由自己处理的异常，都必须以 JSON 返回。
 *
 * 为什么不能省：Express 默认错误处理返回的是一页 HTML，前端
 * `await res.json()` 会抛「Unexpected token '<'」，用户看到的原因和真实故障
 * 完全无关（例如明明是数据库写入失败，却报一个 JSON 解析错误）。
 * 放在路由之后、静态资源之前，才不会影响页面与图片的请求。
 */
app.use('/api', (err, req, res, _next) => {
  console.error(`[api] ${req.method} ${req.originalUrl} 未捕获异常:`, (err && err.stack) || err);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: (err && err.message) || '服务器内部错误' });
});

/**
 * 允许浏览器**内联**渲染的扩展名 → Content-Type。
 * 只有这些后缀会被当作图片返回，其余一律按二进制附件下载。
 */
const INLINE_UPLOAD_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/**
 * uploads 里文件名的前半段是上传时生成的随机 UUID，内容一旦落盘就不再变化
 * （改图 = 换文件名），所以可以放心让浏览器长缓存 —— 这是复访时页面秒开的关键。
 *
 * 为什么必须显式覆盖：闸门开启时全局中间件会统一打上 `no-store`，
 * 那会让每次打开列表都重新下载全部图片。
 * 用 private 是因为开启访问密码时 URL 上会带 site_token，只应缓存在本人机器上。
 */
const IMMUTABLE_CACHE = 'private, max-age=31536000, immutable';
/** 回退成原图、以及非图片的附件：只能短缓存，否则修好之后换不掉 */
const SHORT_CACHE = 'private, max-age=300';

/**
 * /uploads 的响应头策略。
 *
 * 为什么不能直接用 express.static 的默认行为：它按扩展名决定 Content-Type，
 * 于是 uploads 里只要存在一个 .html（上传校验漏掉、或历史遗留），
 * 浏览器就会把它当成**本站同源的页面**执行 —— 脚本可以读走站点访问令牌
 * （那份 Cookie 为了 <img> 能加载而刻意设为非 httpOnly）和登录态。
 * 这里做三层兜底：
 *   1. 扩展名不在白名单 → 强制 application/octet-stream + attachment，只能下载；
 *   2. nosniff 禁止浏览器自行猜测类型；
 *   3. CSP sandbox 让即使被打开的可执行文档也无法运行脚本、发起请求。
 */
function setUploadHeaders(res, filePath, { immutable = true } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  const inlineType = INLINE_UPLOAD_TYPES[ext];
  if (inlineType) {
    res.set('Content-Type', inlineType);
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', immutable ? IMMUTABLE_CACHE : SHORT_CACHE);
  } else {
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment');
    res.set('Cache-Control', SHORT_CACHE);
  }
}

/**
 * 缩略图路由：`/uploads/thumb_<原名去扩展名>.jpg`
 *
 * 放在 express.static 之前按需生成 —— 这样「历史照片」不需要额外的批量
 * 预处理步骤，谁来访问谁触发一次生成，生成完就一直命中磁盘上的文件。
 * 生成失败（含 sharp 未安装）时回退发送原图：功能不受影响，只是慢一些。
 *
 * 注意必须挂在 gateGuardUploads **之后**：缩略图和原图是同一批私有图片，
 * 不能因为换了个文件名就成了免鉴权的旁路。
 */
function serveThumb(req, res, next) {
  let name;
  try {
    name = decodeURIComponent(String(req.path).replace(/^\/+/, ''));
  } catch {
    return res.status(400).end();
  }
  if (!isThumbName(name)) return next();

  resolveThumbRequest(name)
    .then((r) => {
      if (!r) return res.status(404).type('text/plain').send('缩略图不存在');
      setUploadHeaders(res, r.file, { immutable: !r.fellBack });
      return res.sendFile(r.file);
    })
    .catch((e) => {
      console.error('[thumb] 缩略图请求失败:', (e && e.stack) || e);
      if (!res.headersSent) res.status(500).type('text/plain').send('缩略图生成失败');
    });
}

// 图片文件同样受闸门保护（<img> 无法带请求头，改用 site_token 查询参数）
app.use('/uploads', gateGuardUploads, serveThumb, express.static(UPLOAD_DIR, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res, filePath) => setUploadHeaders(res, filePath),
}));

// ---------------------------------------------------------------------------
// 前端入口
// 未解锁时返回内置的密码页；解锁后返回真正的入口页，并在其中注入访问令牌
// 供图片等无法自定义请求头的资源使用。
// ---------------------------------------------------------------------------
let indexHtmlCache = null;
function readIndexHtml() {
  if (indexHtmlCache === null) {
    indexHtmlCache = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf-8');
  }
  return indexHtmlCache;
}

/** 用真实站点名替换入口页中的占位符 */
function renderIndexHtml() {
  return readIndexHtml().replace(/__SITE_NAME__/g, () => escapeHtml(getSiteName()));
}

/** 渲染密码页：替换提示语与站名（占位符可能出现多次，必须全局替换） */
function renderGateHtml(info) {
  let html;
  try {
    html = fs.readFileSync(path.join(DIST_DIR, 'gate.html'), 'utf-8');
  } catch {
    html = '<!doctype html><meta charset="utf-8"><h1>网站已加密</h1><p>缺少 gate.html，请检查部署产物。</p>';
  }
  return html
    .replace(/__SITE_NAME__/g, () => escapeHtml(getSiteName()))
    .replace(/__SITE_HINT__/g, () => escapeHtml(info.hint));
}

// 供密码页使用的静态资源（只暴露密码页样式，不暴露应用 JS）
app.get('/gate.css', (_req, res) => {
  const file = path.join(DIST_DIR, 'gate.css');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type('text/css').sendFile(file);
});

// ---------------------------------------------------------------------------
// 单张照片分享页（服务端渲染）
//
// 为什么独立成页而不是复用 SPA：整站加密时，把未解锁访客放进 SPA 就等于
// 让 bundle 直接去请求 /api/photos 等受保护接口，必然一片空白/401。
// 这里由服务端一次性渲染好这一张照片，只暴露它自己，不放行任何站内 API。
// ---------------------------------------------------------------------------
app.get('/share/:id', (req, res) => {
  const { id } = req.params;
  const token = req.query.t || '';
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('html');

  // 令牌必须有效且**正好对应该照片**，否则不给看
  if (!isShareTokenValidFor(token, id)) {
    return res.status(403).send(renderShareDenied());
  }

  let photo = null;
  try {
    photo = db.prepare(`
      SELECT p.*, u.username as uploader_name
      FROM photos p JOIN users u ON p.uploader_id = u.id
      WHERE p.id = ?
    `).get(id);
  } catch { /* ignore */ }

  if (!photo) return res.status(404).send(renderShareMissing());

  res.send(renderShareHtml(photo, token));
});

app.use(gateGuardAssets);

app.use(express.static(DIST_DIR, { index: false }));

app.get('*', (req, res) => {
  // 令牌可能来自 ?site_token=、X-Site-Token 头，或浏览器自动携带的 Cookie。
  // 必须真正验签通过才返回应用入口，否则任何人拼一个假 token 就能拿到应用页面。
  const token = tokenFromRequest(req);
  const unlocked = isGateEnabled() && !!token;

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('html');

  // 未启用密码，或令牌有效：返回应用入口
  if (!isGateEnabled() || unlocked) {
    if (!isGateEnabled()) return res.send(renderIndexHtml());

    const info = gatePublicInfo();
    const injected = renderIndexHtml().replace(
      '</body>',
      `<script>window.__SITE_TOKEN__=${JSON.stringify(token)};window.__SITE_SESSION_HOURS__=${info.sessionHours};</script>\n</body>`
    );
    return res.send(injected);
  }

  // 未解锁：返回密码页
  res.send(renderGateHtml(gatePublicInfo()));
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 分享页里那张图的 URL（带 share_token，绕过 /uploads 闸门） */
function shareImageUrl(photo, token) {
  return `/uploads/${encodeURIComponent(photo.filename)}?share_token=${encodeURIComponent(token)}`;
}

/** 渲染分享页 */
function renderShareHtml(photo, token) {
  let html;
  try {
    html = fs.readFileSync(path.join(DIST_DIR, 'share.html'), 'utf-8');
  } catch {
    return '<!doctype html><meta charset="utf-8"><h1>分享页缺失</h1>';
  }

  const title = photo.title || '未命名图片';
  const desc = photo.description || '';
  const imgUrl = shareImageUrl(photo, token);
  const stage = photo.mime_type && String(photo.mime_type).startsWith('image/')
    ? `<div class="share__stage"><img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(title)}" /></div>`
    : '<div class="share__stage share__stage--missing">该文件不是可预览的图片格式</div>';

  return html
    .replace(/__SITE_NAME__/g, () => escapeHtml(getSiteName()))
    .replace(/__SHARE_TITLE__/g, () => escapeHtml(title))
    .replace(/__SHARE_DESC__/g, () => escapeHtml(desc).replace(/\s+/g, ' '))
    .replace(/__SHARE_DESC_BLOCK__/g, () => (desc
      ? `<p class="share__desc">${escapeHtml(desc)}</p>` : ''))
    .replace(/__SHARE_UPLOADER__/g, () => escapeHtml(photo.uploader_name || '匿名'))
    .replace(/__SHARE_IMAGE__/g, () => escapeHtml(imgUrl))
    .replace(/__SHARE_DOWNLOAD__/g, () => escapeHtml(imgUrl))
    .replace(/__SHARE_YEAR__/g, () => String(new Date().getFullYear()))
    .replace(/__SHARE_STAGE__/g, () => stage);
}

/** 分享令牌无效 / 未携带 */
function renderShareDenied() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>链接无效</title><link rel="stylesheet" href="/gate.css"></head>
<body><main class="gate" role="main"><section class="gate__card">
<header class="gate__hero"><span class="gate__brand">${escapeHtml(getSiteName())}</span>
<span class="gate__tag">已加密</span></header>
<div class="gate__body"><h1 class="gate__title">这个分享链接无效或已失效</h1>
<p class="gate__hint">请向分享者索要新的链接。</p></div></section></main></body></html>`;
}

/** 照片已被删除 */
function renderShareMissing() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>照片不存在</title><link rel="stylesheet" href="/gate.css"></head>
<body><main class="gate" role="main"><section class="gate__card">
<header class="gate__hero"><span class="gate__brand">${escapeHtml(getSiteName())}</span>
<span class="gate__tag">已加密</span></header>
<div class="gate__body"><h1 class="gate__title">这张照片已被删除或不存在</h1>
<p class="gate__hint">如果这是别人分享给你的链接，可能对方已经撤回了它。</p></div></section></main></body></html>`;
}

function getSiteName() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('site_name');
    if (row?.value) return row.value;
  } catch { /* ignore */ }
  return 'PicFlow';
}

/**
 * 优雅退出：容器收到的 SIGTERM 必须自己接住。
 *
 * 数据库是「内存里改、按需落盘」的 sql.js，默认没有收到信号就落盘这回事。
 * `docker compose down` / `up -d --build` 都会先发 SIGTERM，进程若直接死掉，
 * 最后一次改动就丢了（表现是「刚传完的图重启后不见了」）。
 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] 收到 ${sig}，正在落盘数据库…`);
    try { db.close(); } catch (e) { console.error('[server] 落盘失败:', e.message); }
    process.exit(0);
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PicFlow server running on http://0.0.0.0:${PORT}`);
  console.log(`[gate] 全局访问密码: ${isGateEnabled() ? '已启用' : '未启用'}`);
  // sharp 是异步加载的，给它一点时间再报状态（缺了也不影响功能，只是慢）
  setTimeout(() => {
    console.log(`[thumb] 缩略图: ${thumbnailStatus() === 'ready' ? '已启用' : '不可用（列表将使用原图）'}`);
  }, 1200).unref();
});
