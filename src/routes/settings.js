import { Router } from 'express';
import db from '../database.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();

// 获取所有设置（公开）
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json({ settings });
});

// 更新设置（仅管理员）
router.put('/', authRequired, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: '需要管理员权限' });

  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'invalid settings data' });
  }

  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  const updateMany = db.transaction((data) => {
    for (const [key, value] of Object.entries(data)) {
      update.run(String(value), key);
    }
  });
  updateMany(settings);

  db.save();
  res.json({ ok: true });
});

export default router;
