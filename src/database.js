import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'picflow.db');

let db;

function saveDb() {
  try {
    const data = db.export();
    // 使用 Buffer.from() 显式复制 ArrayBuffer，确保 writeFileSync 拿到独立副本
    const buf = Buffer.from(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    fs.writeFileSync(DB_PATH, buf);
    // 验证写入：如果文件大小为 0 说明写入失败
    const stat = fs.statSync(DB_PATH);
    if (stat.size === 0) {
      console.error(`[db] WARNING: ${DB_PATH} was written but is 0 bytes! Retrying...`);
      fs.writeFileSync(DB_PATH, buf);
      const stat2 = fs.statSync(DB_PATH);
      console.log(`[db] retry: ${DB_PATH} (${stat2.size} bytes)`);
    } else {
      console.log(`[db] saved ${DB_PATH} (${stat.size} bytes)`);
    }
  } catch (e) {
    console.error('[db] Failed to save database:', e.message);
  }
}

// 设置 JSON 文件路径 —— 强制放在数据库同一目录（Docker 中即 /app/data/，在挂载卷上持久化）
const SETTINGS_JSON_PATH = process.env.SETTINGS_JSON_PATH || path.join(path.dirname(DB_PATH), 'settings.json');

function saveSettingsJson(settingsObj) {
  try {
    fs.writeFileSync(SETTINGS_JSON_PATH, JSON.stringify(settingsObj, null, 2), 'utf-8');
    console.log(`[db] settings.json saved (${Object.keys(settingsObj).length} keys)`);
  } catch (e) {
    console.error('[db] Failed to save settings.json:', e.message);
  }
}

function loadSettingsJson() {
  try {
    if (fs.existsSync(SETTINGS_JSON_PATH)) {
      const raw = fs.readFileSync(SETTINGS_JSON_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[db] Failed to load settings.json:', e.message);
  }
  return null;
}

function rowToObj(columns, row) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(...params) {
    this.db.run(this.sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
    return { changes: this.db.getRowsModified() };
  }

  get(...params) {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const stmt = this.db.prepare(this.sql);
    if (flat.length > 0) stmt.bind(flat);
    let row = null;
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      row = rowToObj(cols, vals);
    }
    stmt.free();
    return row;
  }

  all(...params) {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const results = [];
    const stmt = this.db.prepare(this.sql);
    if (flat.length > 0) stmt.bind(flat);
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      results.push(rowToObj(cols, vals));
    }
    stmt.free();
    return results;
  }
}

async function openDatabase() {
  const SQL = await initSqlJs();

  let buffer = null;
  if (fs.existsSync(DB_PATH)) {
    try {
      buffer = fs.readFileSync(DB_PATH);
    } catch {
      buffer = null;
    }
  }

  db = new SQL.Database(buffer);

  // 先尝试创建新格式表（email/password 可为空）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT DEFAULT '',
    password TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // 检测旧表结构并迁移
  try {
    const colInfo = db.exec("PRAGMA table_info(users)");
    if (colInfo.length > 0) {
      const cols = colInfo[0].values;
      const emailNotNull = cols.some(r => r[1] === 'email' && r[3] === 1); // notnull=1
      if (emailNotNull) {
        console.log('Migrating users table to flexible schema...');
        db.run('BEGIN');
        db.run(`CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          email TEXT DEFAULT '',
          password TEXT DEFAULT '',
          bio TEXT DEFAULT '',
          avatar TEXT DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        db.run('INSERT INTO users_new SELECT id, username, email, password, bio, avatar, created_at FROM users');
        db.run('DROP TABLE users');
        db.run('ALTER TABLE users_new RENAME TO users');
        db.run('COMMIT');
        console.log('Users table migration complete.');
      }
    }
  } catch (e) {
    console.log('Migration check skipped:', e.message);
  }

  // 检测并添加 is_admin / is_banned 列
  try {
    const colInfo = db.exec("PRAGMA table_info(users)");
    if (colInfo.length > 0) {
      const cols = colInfo[0].values;
      const hasIsAdmin = cols.some(r => r[1] === 'is_admin');
      if (!hasIsAdmin) {
        db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
        console.log('Added is_admin column to users table.');
      }
      const hasIsBanned = cols.some(r => r[1] === 'is_banned');
      if (!hasIsBanned) {
        db.run('ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0');
        console.log('Added is_banned column to users table.');
      }
    }
  } catch (e) {
    console.log('is_admin/is_banned migration check skipped:', e.message);
  }

  // 设置表 —— 先迁移旧表的 NOT NULL 约束（SQLite 不支持直接 DROP CONSTRAINT）
  try {
    const colInfo = db.exec("PRAGMA table_info(settings)");
    if (colInfo.length > 0) {
      const cols = colInfo[0].values;
      const valueCol = cols.find(r => r[1] === 'value');
      // r[3] === 1 表示 NOT NULL 约束存在
      if (valueCol && valueCol[3] === 1) {
        console.log('[db] Migrating settings table to remove NOT NULL constraint...');
        db.run('BEGIN');
        db.run(`CREATE TABLE settings_new (
          key TEXT PRIMARY KEY,
          value TEXT
        )`);
        db.run('INSERT INTO settings_new SELECT key, COALESCE(value, "") FROM settings');
        db.run('DROP TABLE settings');
        db.run('ALTER TABLE settings_new RENAME TO settings');
        db.run('COMMIT');
        console.log('[db] settings table migration complete.');
      }
    }
  } catch (e) {
    console.log('[db] settings migration check skipped:', e.message);
  }

  // 创建表（如果上面迁移没执行，这里正常创建；如果已迁移，IF NOT EXISTS 跳过）
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // 插入默认设置（使用安全函数确保 value 不为 NULL）
  const year = new Date().getFullYear();
  const defaults = [
    ['site_name', 'PicFlow'],
    ['site_title', 'PicFlow - 图片分享'],
    ['site_icon', ''],
    ['footer_copyright', '(C) ' + year + ' PicFlow'],
  ];

  // 安全插入：跳过 value 为 null/undefined 的条目
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of defaults) {
    if (v != null) insertSetting.run(k, String(v));
  }

  // 从 settings.json 恢复设置（双重保险：即使 sql.js 数据库损坏也能恢复）
  const jsonSettings = loadSettingsJson();
  if (jsonSettings && typeof jsonSettings === 'object' && !Array.isArray(jsonSettings)) {
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    let restored = 0;
    for (const [k, v] of Object.entries(jsonSettings)) {
      if (v != null) {
        upsert.run(k, String(v));
        restored++;
      } else {
        console.log(`[db] Skipping setting "${k}" (value is ${v})`);
      }
    }
    if (restored > 0) console.log(`[db] Restored ${restored} settings from settings.json`);
  }

  db.run(`CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    width INTEGER DEFAULT 800,
    height INTEGER DEFAULT 600,
    size INTEGER DEFAULT 0,
    mime_type TEXT DEFAULT 'image/jpeg',
    uploader_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    likes_count INTEGER DEFAULT 0,
    downloads_count INTEGER DEFAULT 0,
    FOREIGN KEY (uploader_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS likes (
    user_id TEXT NOT NULL,
    photo_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, photo_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_uploader ON photos(uploader_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_likes_photo ON likes(photo_id)`);

  saveDb();

  // 启动诊断：打印当前设置和关键路径
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const current = {};
    for (const r of rows) current[r.key] = r.value;
    console.log(`[db] DB_PATH    = ${DB_PATH}`);
    console.log(`[db] SETTINGS   = ${SETTINGS_JSON_PATH}`);
    console.log(`[db] Current settings:`, JSON.stringify(current));
  } catch (e) { /* ignore */ }

  return {
    prepare: (sql) => new Statement(db, sql),
    exec: (sql) => db.run(sql),
    transaction: (fn) => (...args) => {
      db.run('BEGIN');
      try {
        const result = fn(...args);
        db.run('COMMIT');
        saveDb();
        return result;
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },
    close: () => { saveDb(); db.close(); },
    save: saveDb,
    saveSettingsJson,
    loadSettingsJson,
  };
}

export default await openDatabase();
