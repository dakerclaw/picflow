import { Router } from 'express';
import db from '../database.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();

/**
 * 允许通过这个接口读写（以及落到 settings.json 备份里）的键。
 *
 * 为什么必须白名单：settings 是一张通用 key/value 表，闸门的密码哈希
 * （site_password_hash）就躺在同一张表里。原来 GET 是把整张表**原样**
 * 返回给未登录访客的 —— 打开一次接口就能拿到 bcrypt 哈希回去离线爆破，
 * 顺带还知道站点是不是上了锁、提示语是什么。PUT 同样接受任意键，
 * 相当于把闸门配置的写入口也暴露在这个接口上。
 *
 * 白名单一次挡住两件事：读不到密钥，也写不进密钥。
 * 键清单同时决定 settings.json 备份的内容 —— 备份文件里不会再出现密钥。
 */
const PUBLIC_SETTING_KEYS = ['site_name', 'site_title', 'site_icon', 'footer_copyright'];
const PUBLIC_SETTING_KEY_SET = new Set(PUBLIC_SETTING_KEYS);

// 默认设置值（运行时兜底，也用于空表恢复）
const DEFAULT_SETTINGS = {
  site_name: 'PicFlow',
  site_title: 'PicFlow - 图片分享',
  site_icon: '',
  footer_copyright: `© ${new Date().getFullYear()} PicFlow`,
};

/** 从整张表里只挑出公开键，其余（尤其是闸门密钥）一律丢弃 */
function pickPublicSettings(rows) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (PUBLIC_SETTING_KEY_SET.has(r.key) && r.value != null) settings[r.key] = r.value;
  }
  return settings;
}

// 获取所有设置（公开）
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = pickPublicSettings(rows);

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

  const { settings: data } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'invalid settings data' });
  }

  // 用 INSERT OR REPLACE 代替 UPDATE，表为空时也能插入
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const rejected = [];
  for (const [key, value] of Object.entries(data)) {
    if (!PUBLIC_SETTING_KEY_SET.has(key)) { rejected.push(key); continue; }
    if (value == null) continue;
    upsert.run(key, String(value));
  }
  if (rejected.length > 0) {
    console.warn(`[settings] 已忽略白名单外的键: ${rejected.join(', ')}`);
  }

  const result = pickPublicSettings(db.prepare('SELECT key, value FROM settings').all());

  // 持久化到磁盘（写入的是公开设置，不含闸门密钥）
  db.save();
  db.saveSettingsJson(result);

  console.log(`[settings] PUT saved:`, JSON.stringify(result));
  res.json({ ok: true, settings: result });
});

export default router;
