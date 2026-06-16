import jwt from 'jsonwebtoken';
import db from '../database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'picflow-secret-change-in-production';

export function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username, email: user.email, is_admin: user.is_admin || 0 }, JWT_SECRET, { expiresIn: '7d' });
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    // 从数据库获取最新用户信息（含 is_admin）
    const dbUser = db.prepare('SELECT id, username, email, is_admin FROM users WHERE id = ?').get(decoded.id);
    if (!dbUser) return res.status(401).json({ error: '用户不存在' });
    req.user = { id: dbUser.id, username: dbUser.username, email: dbUser.email, is_admin: dbUser.is_admin || 0 };
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

export function authOptional(req, _res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const token = header.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      const dbUser = db.prepare('SELECT id, username, email, is_admin FROM users WHERE id = ?').get(decoded.id);
      if (dbUser) req.user = { id: dbUser.id, username: dbUser.username, email: dbUser.email, is_admin: dbUser.is_admin || 0 };
    } catch { /* ignore */ }
  }
  next();
}
