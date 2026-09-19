import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { DB_PATH, SETTINGS_JSON_PATH, GATE_SETTING_KEY_SET as GATE_KEYS } from './config.js';

let db;

/**
 * 「有没有还没落盘的改动」。
 *
 * 为什么需要：写操作原来一律在响应结束时无脑落盘一次（见 index.js 的 res.end
 * 钩子），于是**登录**这种完全不写库的 POST 也会触发一次「导出整库 + 写盘」。
 * 库小的时候只是白花几毫秒，库大了（几万张照片）就是几十毫秒纯浪费，
 * 而且这段时间是同步阻塞的，所有请求都得排队。
 */
let dirty = false;

/** 与数据库同目录的临时文件，保证 rename 是同文件系统内的原子替换 */
const DB_TMP_PATH = DB_PATH + '.tmp';

/**
 * 落盘数据库。
 *
 * 必须是「先写临时文件、再 rename 覆盖」：直接 writeFileSync 覆盖原文件的
 * 那一瞬间，磁盘上是一个被截断的、不可用的数据库；只要进程恰好在这时被
 * 杀掉（docker compose down、OOM、断电），整个站点的数据就没了。
 * rename 在同一文件系统内是原子操作，任何时刻读到的都是「旧完整版」或
 * 「新完整版」，不存在中间态。
 */
function saveDb() {
  try {
    const data = db.export();
    // 使用 Buffer.from() 显式复制 ArrayBuffer，确保 writeFileSync 拿到独立副本
    const buf = Buffer.from(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (buf.length === 0) {
      console.error(`[db] 导出的数据库是 0 字节，已放弃本次落盘以免覆盖完整数据。`);
      return;
    }
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_TMP_PATH, buf);
    const tmpSize = fs.statSync(DB_TMP_PATH).size;
    if (tmpSize !== buf.length) {
      console.error(`[db] 临时文件写入不完整（${tmpSize}/${buf.length} 字节），已放弃本次落盘。`);
      return;
    }
    fs.renameSync(DB_TMP_PATH, DB_PATH);
    dirty = false;
    console.log(`[db] saved ${DB_PATH} (${buf.length} bytes)`);
  } catch (e) {
    console.error('[db] Failed to save database:', e.message);
  }
}

/**
 * 导出一份设置备份（同目录的 settings.json）。
 *
 * 注意这里落盘的是**公开设置**（站名、标题等），闸门密码哈希这类密钥不应写进
 * 明文备份文件（见 routes/settings.js 的白名单）。
 */
function saveSettingsJson(settingsObj) {
  try {
    const tmp = SETTINGS_JSON_PATH + '.tmp';
    fs.mkdirSync(path.dirname(SETTINGS_JSON_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(settingsObj, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_JSON_PATH);
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

  /**
   * 注意：**不要**在 openDatabase 内部直接用 sql.js 原生的
   * `db.prepare(sql).run(a, b)` 写数据。原生 Statement.run() 只接受「一个」
   * 参数（数组或对象），传成两个位置参数时它会把这个值当成对象去绑定，
   * 结果所有占位符全部落成 NULL —— 而且**不报任何错**。
   * 这里包一层的意义就是把这个坑堵住：无论调用方怎么写都能正确绑定。
   */
  run(...params) {
    this.db.run(this.sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
    dirty = true;
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

  // 注意：以下所有**写**操作都必须走本文件包装过的 Statement，不能用
  // sql.js 原生的 db.prepare()。原生 Statement.run() 只接受一个参数，
  // 写成 run(k, v) 时所有占位符会静默落成 NULL（详见类注释）。
  const prep = (sql) => new Statement(db, sql);

  // 清掉历史上被写坏的「空键」行。
  //
  // 2026-09 之前这里用的是 sql.js 原生 Statement.run(k, v)，两个位置参数会被
  // 静默绑定成 NULL，于是每次全新安装都会在 settings 里留下 7 行 [null, null]
  // （TEXT PRIMARY KEY 在 SQLite 里允许 NULL，所以连主键重复都不报）。
  // 这些行本身没有意义，留着只会让「设置表是空的」这个事实看不出来。
  try {
    const cleaned = prep('DELETE FROM settings WHERE key IS NULL OR key = ?').run('');
    if (cleaned.changes > 0) console.log(`[db] 清理了 ${cleaned.changes} 行无主设置（历史写入缺陷遗留）`);
  } catch (e) {
    console.log('[db] 空键清理跳过:', e.message);
  }

  // 插入默认设置（使用安全函数确保 value 不为 NULL）
  const year = new Date().getFullYear();
  const defaults = [
    ['site_name', 'PicFlow'],
    ['site_title', 'PicFlow - 图片分享'],
    ['site_icon', ''],
    ['footer_copyright', '(C) ' + year + ' PicFlow'],
  ];

  // 安全插入：跳过 value 为 null/undefined 的条目
  const insertSetting = prep('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of defaults) {
    if (v != null) insertSetting.run(k, String(v));
  }

  // 从 settings.json 恢复设置（双重保险：即使 sql.js 数据库损坏也能恢复）
  //
  // 语义必须是「只补缺失的键」（INSERT OR IGNORE），不能是覆盖式写入：
  // 覆盖意味着磁盘上一个陈旧的备份文件能在每次重启时把管理员的**新**设置
  // 改回旧值 —— 例如明明在后台关掉了访问密码，重启一次又锁上了。
  const jsonSettings = loadSettingsJson();
  if (jsonSettings && typeof jsonSettings === 'object' && !Array.isArray(jsonSettings)) {
    const fillMissing = prep('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    let restored = 0;
    const skipped = [];
    for (const [k, v] of Object.entries(jsonSettings)) {
      if (k === '') continue;
      // 闸门相关密钥一律不从备份文件恢复：它们是管理员显式配置的，
      // 让一个磁盘文件决定「站点是否上锁」只会带来难以解释的锁定。
      if (GATE_KEYS.has(k)) { skipped.push(k); continue; }
      if (v == null) {
        console.log(`[db] Skipping setting "${k}" (value is ${v})`);
        continue;
      }
      // 只有真的插进去了才算恢复（INSERT OR IGNORE 命中已有键时 changes 为 0）
      if (fillMissing.run(k, String(v)).changes > 0) restored++;
    }
    if (restored > 0) console.log(`[db] Restored ${restored} settings from settings.json`);
    if (skipped.length > 0) {
      console.log(`[db] 备份里的闸门密钥未参与恢复（以数据库为准）: ${skipped.join(', ')}`);
    }
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
    exec: (sql) => { dirty = true; return db.run(sql); },
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
    isDirty: () => dirty,
    saveSettingsJson,
    loadSettingsJson,
  };
}

export default await openDatabase();
