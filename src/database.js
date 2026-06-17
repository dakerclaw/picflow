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
    // 直接写入 Uint8Array，避免 Buffer.from() 序列化问题
    const tmpPath = DB_PATH + '.tmp';
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, DB_PATH);
    console.log(`[db] saved to ${DB_PATH} (${data.length} bytes)`);
  } catch (e) {
    console.error('[db] Failed to save database:', e.message);
  }
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

  // 设置表
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // 插入默认设置
  const defaults = [
    ['site_name', 'PicFlow'],
    ['site_title', 'PicFlow - 图片分享'],
    ['site_icon', ''],
    ['footer_copyright', `© ${new Date().getFullYear()} PicFlow`],
  ];
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of defaults) {
    insertSetting.run(k, v);
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
  };
}

export default await openDatabase();
