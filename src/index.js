import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';
import authRoutes from './routes/auth.js';
import photoRoutes from './routes/photos.js';
import settingsRoutes from './routes/settings.js';
import adminRoutes from './routes/admin.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

const DIST_DIR = path.join(__dirname, '..', 'dist');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

app.disable('etag');
app.use(cors({ exposedHeaders: ['X-Site-Required'] }));
app.use(express.json());

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
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(_req.method)) {
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

// 图片文件同样受闸门保护（<img> 无法带请求头，改用 site_token 查询参数）
app.use('/uploads', gateGuardUploads, express.static(path.join(__dirname, '..', 'uploads')));

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PicFlow server running on http://0.0.0.0:${PORT}`);
  console.log(`[gate] 全局访问密码: ${isGateEnabled() ? '已启用' : '未启用'}`);
});
