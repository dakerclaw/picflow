import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../database.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'picflow-secret-change-in-production';

// 全局访问密码相关配置
export const SITE_PASSWORD_KEY = 'site_password_hash';     // bcrypt 哈希
export const SITE_PASSWORD_ENABLED_KEY = 'site_password_enabled'; // 0/1
export const SITE_PASSWORD_HINT_KEY = 'site_password_hint';       // 提示文案
export const SESSION_HOURS_KEY = 'site_password_session_hours';   // 会话有效小时数

const DEFAULTS = {
  [SITE_PASSWORD_ENABLED_KEY]: '0',
  [SITE_PASSWORD_HINT_KEY]: '请输入访问密码',
  [SESSION_HOURS_KEY]: '12',
};

export function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null) return row.value;
  } catch { /* ignore */ }
  return DEFAULTS[key];
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

// 缓存 IP 限速用的失败次数（内存态，重启即清空）
const attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

/** 当前是否启用了全局访问密码 */
export function isGateEnabled() {
  if (getSetting(SITE_PASSWORD_ENABLED_KEY) !== '1') return false;
  const hash = getSetting(SITE_PASSWORD_KEY);
  return !!hash;
}

/** Cookie 名：解锁后由服务端种下，浏览器自动携带，用于 <script>/<link> 这类请求 */
export const GATE_COOKIE = 'picflow_site_token';

/** 校验请求携带的访问令牌是否有效 */
function verifyGateToken(req) {
  const header = req.headers['x-site-token'] || req.query.site_token;
  if (!header) return false;
  return isGateTokenValid(header);
}

/**
 * 从 Cookie 里取访问令牌。
 *
 * 为什么需要它：入口页里的 <script src="./assets/xxx.js"> 与 <link href="...css">
 * 是**浏览器自己**发起的请求，JS 无法给它们附加 X-Site-Token 头，
 * 也无法给它们拼 site_token 查询参数。若这类请求也被闸门要求令牌，
 * 就会出现「密码输对了、入口页也返回了，但 bundle 401 → 整页空白」。
 * Cookie 由浏览器自动携带，正好覆盖这类拿不到自定义头的请求。
 */
function tokenFromCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === GATE_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return '';
}

/** 同时接受 请求头 / 查询参数 / Cookie 三种来源的令牌 */
function verifyGateTokenAny(req) {
  if (verifyGateToken(req)) return true;
  return isGateTokenValid(tokenFromCookie(req));
}

/**
 * 取出请求中的访问令牌（按 请求头 → 查询参数 → Cookie 的优先级），
 * 并用它验签。返回验签通过的那个令牌字符串，无效则返回 ''。
 *
 * 供入口页路由使用：无论访客是从 ?site_token= 进来的，还是靠 Cookie 直接访问首页，
 * 都应拿到应用入口，而不是被反复丢回密码页。
 */
export function tokenFromRequest(req) {
  const candidates = [
    req.headers['x-site-token'],
    req.query.site_token,
    tokenFromCookie(req),
  ];
  for (const c of candidates) {
    if (c && isGateTokenValid(c)) return String(c);
  }
  return '';
}

/** Cookie 名与属性（同站即可，无需跨站） */
/**
 * 单独校验一个令牌字符串是否有效（供入口页路由复用，避免 URL 传假令牌被骗过）。
 * 只接受 scope=site 的令牌，不能拿用户 JWT 当访问令牌。
 */
export function isGateTokenValid(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return !!decoded && decoded.scope === 'site';
  } catch {
    return false;
  }
}

/**
 * 全局访问守卫：启用密码后，所有未携带有效令牌的请求一律拒绝。
 * 注意：守卫挂在 '/api' 上，req.path 已是去掉前缀后的路径。
 * 解锁接口本身由 index.js 在守卫之前注册，这里无需再放行。
 */
export function gateGuard(req, res, next) {
  if (!isGateEnabled()) return next();
  // 已被前置守卫（如管理员豁免）判定放行的请求，这里不再重复拦截
  if (req.__gatePassed) return next();
  if (verifyGateTokenAny(req)) return next();

  return res.status(401).json({
    error: '需要访问密码',
    code: 'SITE_LOCKED',
    gate: gatePublicInfo(),
  });
}

/**
 * 闸门 + 管理员豁免守卫。
 *
 * 用于「管理访问密码」这类接口：它们本身就是用来配置闸门的，
 * 若也要求先解锁，就会出现「管理员想改密码 / 关闭闸门，却因为没解锁而改不了」的死锁。
 * 因此这里额外放行持有合法管理员 JWT 的请求 —— 身份校验仍由后续 adminRequired 兜底，
 * 普通用户与非管理员依旧被闸门拦下。
 *
 * 注意：放行时必须打上 req.__gatePassed 标记。因为本中间件挂在 /api 通用闸门之前，
 * 只调用 next() 会继续流到后面的 gateGuard，那里仍会以「未携带访问令牌」为由拒绝。
 */
export function gateGuardAllowAdmin(req, res, next) {
  if (!isGateEnabled()) return next();
  if (verifyGateTokenAny(req) || isAdminToken(req)) {
    req.__gatePassed = true;
    return next();
  }

  return res.status(401).json({
    error: '需要访问密码',
    code: 'SITE_LOCKED',
    gate: gatePublicInfo(),
  });
}

/** 校验请求头中的 JWT 是否为管理员身份（不抛异常，仅用于闸门豁免判定） */
function isAdminToken(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return false;
  try {
    const decoded = jwt.verify(m[1], JWT_SECRET);
    if (!decoded || decoded.scope === 'site') return false;
    const id = decoded.id || decoded.userId || decoded.sub;
    if (!id) return false;
    const row = db.prepare('SELECT is_admin, is_banned FROM users WHERE id = ?').get(id);
    return !!row && Number(row.is_admin) === 1 && Number(row.is_banned) !== 1;
  } catch {
    return false;
  }
}

/** /uploads 静态资源的守卫（支持 <img> 标签，失败时返回 1x1 透明图） */
export function gateGuardUploads(req, res, next) {
  if (!isGateEnabled()) return next();
  if (verifyGateTokenAny(req)) return next();

  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'image/svg+xml');
  return res.status(401).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
}

/** 对外暴露的公开信息（不含密码本身） */
export function gatePublicInfo() {
  return {
    enabled: isGateEnabled(),
    hint: getSetting(SITE_PASSWORD_HINT_KEY) || '请输入访问密码',
    sessionHours: Number(getSetting(SESSION_HOURS_KEY)) || 12,
  };
}

/**
 * 静态资源守卫：加密状态下，前端 JS/CSS 等构建产物同样不允许匿名获取，
 * 否则未解锁的访客可以拿到应用代码。
 *
 * 注意：只拦截「扩展名明确的静态文件」，HTML 文档（入口页 / 密码页）必须放行，
 * 由后面的路由决定返回哪一个，否则未解锁时会连密码页都拿不到。
 */
const STATIC_FILE_RE = /\.[a-z0-9]{1,8}$/i;

export function gateGuardAssets(req, res, next) {
  if (!isGateEnabled()) return next();
  // 浏览器自动发起的 <script>/<link> 请求只能靠 Cookie 证明身份
  if (verifyGateTokenAny(req)) return next();
  // HTML 文档交给后续路由处理
  if (!STATIC_FILE_RE.test(req.path)) return next();
  // 密码页自身的资源必须放行
  if (req.path === '/gate.css' || req.path === '/favicon.ico') return next();

  res.set('Cache-Control', 'no-store');
  return res.status(401).type('text/plain').send('需要访问密码');
}

// GET /api/gate/status — 前端用来判断是否需要展示密码页
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const info = gatePublicInfo();
  res.json({ ...info, authorized: !info.enabled ? true : verifyGateTokenAny(req) });
});

// POST /api/gate/unlock — 提交密码换取访问令牌
router.post('/unlock', (req, res) => {
  if (!isGateEnabled()) return res.json({ ok: true, enabled: false });

  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
  }

  const password = String(req.body?.password ?? '');
  if (!password) return res.status(400).json({ error: '请输入密码' });

  const hash = getSetting(SITE_PASSWORD_KEY);
  if (!bcrypt.compareSync(password, hash)) {
    recordFailure(ip);
    const left = Math.max(0, MAX_ATTEMPTS - (attempts.get(ip)?.count || 0));
    return res.status(401).json({ error: `密码错误${left <= 3 ? `（剩余 ${left} 次机会）` : ''}` });
  }

  clearAttempts(ip);
  const hours = Number(getSetting(SESSION_HOURS_KEY)) || 12;
  const token = jwt.sign({ scope: 'site' }, JWT_SECRET, { expiresIn: `${hours}h` });

  // 同时种下 Cookie：入口页的 <script>/<link> 由浏览器自动发起，
  // 拿不到自定义请求头，只能依赖浏览器自动携带的 Cookie。
  // 不设 Max-Age，与「关闭浏览器即失效」的产品预期一致（会话 Cookie）。
  const secure = req.secure || String(req.get('x-forwarded-proto') || '').includes('https');
  res.cookie(GATE_COOKIE, token, {
    httpOnly: false,          // 前端需要读取（图片 URL 会拼 site_token）
    sameSite: 'lax',
    secure,
    path: '/',
  });

  res.json({ ok: true, token, expiresInHours: hours });
});

/** 管理员修改访问密码 / 开关 */
export function readGateSettings() {
  return {
    enabled: isGateEnabled(),
    hasPassword: !!getSetting(SITE_PASSWORD_KEY),
    hint: getSetting(SITE_PASSWORD_HINT_KEY) || '',
    sessionHours: Number(getSetting(SESSION_HOURS_KEY)) || 12,
  };
}

export function writeGateSettings({ enabled, password, hint, sessionHours }) {
  let passwordSet = false;
  if (password !== undefined && password !== null && String(password).length > 0) {
    if (String(password).length < 4) throw new Error('密码至少 4 位');
    setSetting(SITE_PASSWORD_KEY, bcrypt.hashSync(String(password), 10));
    passwordSet = true;
  }
  // 开启保护前必须已有密码（或本次一并设置），否则拒绝，
  // 避免出现「enabled=1 但没有密码」这种读到 enabled:false 的假成功状态。
  if (enabled !== undefined) {
    const willEnable = !!enabled;
    if (willEnable && !passwordSet && !getSetting(SITE_PASSWORD_KEY)) {
      throw new Error('请先设置访问密码');
    }
    setSetting(SITE_PASSWORD_ENABLED_KEY, willEnable ? '1' : '0');
  }
  if (hint !== undefined) setSetting(SITE_PASSWORD_HINT_KEY, String(hint));
  if (sessionHours !== undefined) {
    const h = Number(sessionHours);
    setSetting(SESSION_HOURS_KEY, String(Number.isFinite(h) && h > 0 ? Math.min(720, Math.floor(h)) : 12));
  }
  db.save();
}

export default router;
