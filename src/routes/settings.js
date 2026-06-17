import { Router } from 'express';
import db from '../database.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();

// 默认设置值（运行时兜底，也用于空表恢复）
const DEFAULT_SETTINGS = {
  site_name: 'PicFlow',
  site_title: 'PicFlow - 图片分享',
  site_icon: '',
  footer_copyright: `© ${new Date().getFullYear()} PicFlow`,
};

// 获取所有设置（公开）
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...DEFAULT_SETTINGS };  // 兜底默认值
  for (const r of rows) settings[r.key] = r.value;

  // 如果数据库是空的，初始化进去
  if (rows.length === 0) {
    console.warn('[settings] settings 表为空，正在初始化默认值...');
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      upsert.run(k, v);
    }
    db.save();
  }

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

  // 用 INSERT OR REPLACE 代替 UPDATE，表为空时也能插入
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(data)) {
    upsert.run(key, String(value));
  }

  // 读回最新值
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = { ...DEFAULT_SETTINGS };
  for (const r of rows) result[r.key] = r.value;

  // 持久化到磁盘
  db.save();
  db.saveSettingsJson(result);

  console.log(`[settings] PUT saved:`, JSON.stringify(result));
  res.json({ ok: true, settings: result });
});

export default router;
