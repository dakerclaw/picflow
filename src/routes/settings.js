import { Router } from 'express';
import db from '../database.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();

// 获取所有设置（公开）
// 始终以 SQLite 内存数据库为准（在 Docker 中 picflow.db 在挂载卷上，可靠持久化）
// settings.json 仅在启动时用于恢复，运行时不再从中读取
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;

  // 禁止浏览器/代理缓存，确保刷新后一定拿到最新值
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.json({ settings });
});

// 更新设置（仅管理员）
router.put('/', authRequired, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: '需要管理员权限' });

  const { settings: data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'invalid settings data' });
  }

  // 逐条更新，不使用 transaction 避免 sql.js 潜在问题
  for (const [key, value] of Object.entries(data)) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
  }

  // 直接从内存读取最新值
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const r of rows) result[r.key] = r.value;

  // 持久化到磁盘（双重保险：sql.js + settings.json）
  db.save();
  db.saveSettingsJson(result);

  res.json({ ok: true, settings: result });
});

export default router;
