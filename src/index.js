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
} from './routes/gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

const DIST_DIR = path.join(__dirname, '..', 'dist');

app.disable('etag');
app.use(cors({ exposedHeaders: ['X-Site-Required'] }));
app.use(express.json());

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
