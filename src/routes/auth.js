import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import db from '../database.js';
import { generateToken, authRequired } from '../middleware/auth.js';

const router = Router();

router.post('/register', (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: '用户名、邮箱和密码为必填项' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码不能少于 6 位' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) {
    return res.status(409).json({ error: '用户名或邮箱已被注册' });
  }

  const id = uuidv4();
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, email, password) VALUES (?, ?, ?, ?)').run(id, username, email, hashed);

  const user = { id, username, email, bio: '', avatar: '' };
  const token = generateToken(user);
  res.status(201).json({ user, token });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码为必填项' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '邮箱或密码不正确' });
  }

  const token = generateToken(user);
  res.json({
    user: { id: user.id, username: user.username, email: user.email, bio: user.bio, avatar: user.avatar, created_at: user.created_at },
    token,
  });
});

router.get('/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT id, username, email, bio, avatar, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user });
});

router.put('/me', authRequired, (req, res) => {
  const { username, bio } = req.body;
  const updates = {};
  if (username !== undefined) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (existing) return res.status(409).json({ error: '用户名已被使用' });
    updates.username = username;
  }
  if (bio !== undefined) updates.bio = bio;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: '没有需要更新的内容' });
  }

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), req.user.id];
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values);

  const user = db.prepare('SELECT id, username, email, bio, avatar, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

export default router;
