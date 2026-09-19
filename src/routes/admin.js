import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import db from '../database.js';
import { authRequired } from '../middleware/auth.js';
import { readGateSettings, writeGateSettings } from './gate.js';
import { UPLOAD_DIR } from '../config.js';
import { deleteThumbFor } from '../thumbnails.js';

const router = Router();

// 所有管理员接口都需要登录 + is_admin
function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: '需要管理员权限' });
    next();
  });
}

// GET /api/admin/users - 获取所有用户列表
router.get('/users', adminRequired, (req, res) => {
  const users = db.prepare(
    'SELECT id, username, email, bio, avatar, is_admin, is_banned, created_at FROM users ORDER BY created_at DESC'
  ).all();
  // 附带每个用户的图片数量
  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM photos WHERE uploader_id = ?');
  const result = users.map(u => ({
    ...u,
    is_admin: u.is_admin || 0,
    is_banned: u.is_banned || 0,
    photo_count: countStmt.get(u.id)?.cnt || 0,
  }));
  res.json({ users: result });
});

// DELETE /api/admin/users/:id - 删除用户（同时删除其所有图片文件）
router.delete('/users/:id', adminRequired, (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己的账号' });

  const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.is_admin) return res.status(400).json({ error: '不能删除管理员账号' });

  // 获取用户所有图片文件，然后删除文件
  const userPhotos = db.prepare('SELECT filename FROM photos WHERE uploader_id = ?').all(id);
  for (const p of userPhotos) {
    try {
      const fp = path.join(UPLOAD_DIR, p.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) {
      console.warn(`删除图片文件失败（${p.filename}）: ${e.message}`);
    }
    // 缩略图的命名规则统一由 thumbnails.js 决定（原来是拼 'thumb_' + 原文件名，
    // 而实际生成的是 .jpg，对不上 → 删了原图，缩略图会永远留在磁盘上）
    deleteThumbFor(p.filename);
  }

  // 删除数据库记录（photos 有 ON DELETE CASCADE 的 likes）
  db.prepare('DELETE FROM photos WHERE uploader_id = ?').run(id);
  db.prepare('DELETE FROM likes WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.save();

  res.json({ ok: true });
});

// POST /api/admin/users/:id/ban - 切换屏蔽状态
router.post('/users/:id/ban', adminRequired, (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error: '不能屏蔽自己的账号' });

  const target = db.prepare('SELECT id, is_admin, is_banned FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.is_admin) return res.status(400).json({ error: '不能屏蔽管理员账号' });

  const newBanned = target.is_banned ? 0 : 1;
  db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(newBanned, id);
  db.save();

  res.json({ ok: true, is_banned: newBanned });
});

// GET /api/admin/site-password - 读取全局访问密码设置
router.get('/site-password', adminRequired, (_req, res) => {
  res.json({ sitePassword: readGateSettings() });
});

// PUT /api/admin/site-password - 修改全局访问密码设置
router.put('/site-password', adminRequired, (req, res) => {
  const { enabled, password, hint, sessionHours } = req.body || {};
  try {
    writeGateSettings({ enabled, password, hint, sessionHours });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  console.log('[admin] site-password updated:', JSON.stringify(readGateSettings()));
  res.json({ ok: true, sitePassword: readGateSettings() });
});

export default router;
