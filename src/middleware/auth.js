import jwt from 'jsonwebtoken';
import db from '../database.js';
import { JWT_SECRET } from '../config.js';

export function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username, email: user.email, is_admin: user.is_admin || 0 }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * 取用户并把「是否被封禁」一并查出来。
 *
 * 为什么每次请求都要查库、不能只信令牌：令牌有 7 天有效期。管理员点下
 * 「屏蔽」之后，如果鉴权只看令牌，被封的人拿着旧令牌还能畅通无阻地
 * 继续上传、点赞、删图 —— 屏蔽按钮等于失效。代价是一次主键查询，可接受。
 */
const SELECT_USER = 'SELECT id, username, email, is_admin, is_banned FROM users WHERE id = ?';

function loadUser(decoded) {
  try {
    const row = db.prepare(SELECT_USER).get(decoded && decoded.id);
    if (!row) return null;
    if (Number(row.is_banned) === 1) return { banned: true };
    return { banned: false, user: { id: row.id, username: row.username, email: row.email, is_admin: row.is_admin || 0 } };
  } catch {
    return null;
  }
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const token = header.slice('Bearer '.length).trim();
    const decoded = jwt.verify(token, JWT_SECRET);
    const found = loadUser(decoded);
    if (!found) return res.status(401).json({ error: '用户不存在' });
    if (found.banned) return res.status(403).json({ error: '该账号已被封禁，请联系管理员' });
    req.user = found.user;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

export function authOptional(req, _res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const token = header.slice('Bearer '.length).trim();
      const decoded = jwt.verify(token, JWT_SECRET);
      const found = loadUser(decoded);
      if (found && !found.banned) req.user = found.user;
    } catch { /* 匿名可访问：令牌无效就当游客处理 */ }
  }
  next();
}
