/**
 * 集中式运行时配置。
 *
 * 为什么必须集中：路径原来散落在 index.js / routes/photos.js / routes/admin.js
 * 里各自用 `path.join(__dirname, '..', ...)` 推导，JWT 密钥则在 gate.js 与
 * middleware/auth.js 里各写了一遍 `process.env.JWT_SECRET || '固定默认值'`。
 * 只要有人设了 UPLOAD_DIR，静态目录与「删用户时删文件」就会指向不同目录，
 * 表现为「上传成功但图片 404」「删了账号磁盘上文件还在」这类极难排查的问题；
 * 密钥写两遍则会改一处漏一处。统一到这里之后不可能再走偏。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// .env 支持
//
// Node 自己不会读 .env，而项目里到处都按「有 .env 就生效」在用：
// install.sh 会生成它、.env.example 就是给用户复制的、systemd 通过
// EnvironmentFile 读它、Docker 通过 environment 传值。可手动 `npm start`、
// PM2、nohup 这三条路都读不到 —— PM2 默认也不读 .env。
// 后果很具体：同样是用一键脚本装好的站点，systemd 方式跑在 3000，
// PM2 方式却悄悄跑在 3001，而脚本打印的访问地址是 3000。
//
// 这里补一个最小加载器，规则是「只填 process.env 里没有的键」：
// 真实环境变量永远优先，所以 Docker 的 environment 与 systemd 的
// EnvironmentFile 完全不受影响，只有确实没人设过的键才会从 .env 取值。
// （不用 process.loadEnvFile() 是因为它要 Node 20.12+，而本项目支持 18+。）
// ---------------------------------------------------------------------------
loadEnvFile();

function loadEnvFile() {
  const file = path.join(SERVER_ROOT, '.env');
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let value = m[2];
      if (value.length > 1 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch (e) {
    console.warn(`[config] 读取 ${file} 失败: ${e.message}`);
  }
}

export const IS_PROD = process.env.NODE_ENV === 'production';
export const PORT = Number(process.env.PORT) || 3001;

/** 上传文件落盘目录（/uploads 静态服务、上传写入、删用户删文件 三处共用这一个值） */
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(SERVER_ROOT, 'uploads');

export const DB_PATH = process.env.DB_PATH || path.join(SERVER_ROOT, 'picflow.db');

/** 数据库所在目录 —— Docker 里就是挂载卷 /app/data，一切都必须放在卷上才能持久化 */
export const DATA_DIR = path.dirname(DB_PATH);

export const SETTINGS_JSON_PATH = process.env.SETTINGS_JSON_PATH || path.join(DATA_DIR, 'settings.json');

export const DIST_DIR = path.join(SERVER_ROOT, 'dist');

/**
 * 闸门（整站访问密码）相关设置键。
 *
 * 集中在这里的原因：这几个键是敏感配置，既不能出现在公开的 /api/settings
 * 响应里，也不该被写进明文的 settings.json 备份、更不该由备份文件来决定
 * 「站点是否上锁」。把清单放在一处，routes/gate.js 的键名常量也由它派生，
 * 将来加键不会漏掉任何一处过滤。
 */
export const GATE_SETTING_KEYS = [
  'site_password_hash',
  'site_password_enabled',
  'site_password_hint',
  'site_password_session_hours',
];

export const GATE_SETTING_KEY_SET = new Set(GATE_SETTING_KEYS);

/**
 * 反向代理支持。默认关闭。
 *
 * 打开后 express 才会相信 X-Forwarded-For / X-Forwarded-Proto。为什么默认关：
 * 若应用本身可被公网直连而你又开了它，任何人伪造一个 X-Forwarded-For 就能
 * 让「按 IP 限速」形同虚设（每次换一个假 IP 即可无限试密码）。
 * 反过来，挂在 nginx 后面却不开它，所有访客会被算成同一个 IP，
 * 达到 10 次失败就把**全站**锁 10 分钟。所以由部署者按实际情况显式声明。
 *
 * 取值：TRUST_PROXY=1（信任一层代理）或 true / loopback 等 express 预设。
 */
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

function parseTrustProxy(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  if (v === 'true' || v === 'on' || v === 'yes') return true;
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return v; // 交给 express 自己解析（如 loopback）
}

// ---------------------------------------------------------------------------
// JWT 密钥
//
// 这是整套访问控制的地基：站点访问令牌（scope=site）、分享令牌、用户登录态
// 全部由它签名。如果它是个公开的固定字符串，任何人本地签一个 scope=site 的
// 令牌就能**直接跳过整站访问密码**，分享令牌也可以随便伪造。
// 而 compose 与 Dockerfile 里恰好都写着固定的占位值 —— 也就是「默认部署
// 等于没有防护」。所以：占位值与未配置一律不用，改为首次启动随机生成并
// 持久化到数据卷；只有显式配置的、不像占位值的密钥才会被采用。
// ---------------------------------------------------------------------------
const PLACEHOLDER_SECRETS = new Set([
  'picflow-secret-change-in-production',
  'picflow-production-secret',
  'change-me-to-a-random-string',
  'changeme',
  'change-me',
  'secret',
  'password',
  'picflow',
  'test',
  'your-secret-key',
]);

export const JWT_SECRET_FILE = process.env.JWT_SECRET_FILE || path.join(DATA_DIR, '.jwt-secret');

export const JWT_SECRET = resolveJwtSecret();

function resolveJwtSecret() {
  const fromEnv = String(process.env.JWT_SECRET || '').trim();

  if (fromEnv && !PLACEHOLDER_SECRETS.has(fromEnv.toLowerCase())) {
    if (fromEnv.length < 16) {
      console.warn(`[config] 警告：JWT_SECRET 长度只有 ${fromEnv.length} 位，太短，建议用 32 位以上随机字符串。`);
    }
    return fromEnv;
  }

  if (fromEnv) {
    console.warn(
      '[config] JWT_SECRET 被设置成了公开的示例值，这个值谁都知道，' +
      '任何人都能伪造令牌绕过访问密码，因此**不予采用**。'
    );
  }

  const persisted = readSecretFile();
  if (persisted) return persisted;

  const generated = crypto.randomBytes(48).toString('hex');
  if (writeSecretFile(generated)) {
    console.log(`[config] 已自动生成 JWT 密钥并保存到 ${JWT_SECRET_FILE}`);
    console.log('[config] 请务必把该文件所在目录（Docker 里是 data 卷）纳入备份；删掉它等于全站令牌作废。');
  } else {
    console.error(
      `[config] 无法写入 ${JWT_SECRET_FILE}，本次使用临时随机密钥：` +
      '服务一重启，所有登录态与分享链接都会失效。请给该目录写权限，或显式设置 JWT_SECRET。'
    );
  }
  return generated;
}

function readSecretFile() {
  try {
    const raw = fs.readFileSync(JWT_SECRET_FILE, 'utf-8').trim();
    if (raw.length >= 32) return raw;
    if (raw.length > 0) {
      console.warn(`[config] ${JWT_SECRET_FILE} 里的密钥太短（${raw.length} 位），重新生成。`);
    }
  } catch { /* 文件不存在：正常，下面生成 */ }
  return '';
}

function writeSecretFile(secret) {
  try {
    fs.mkdirSync(path.dirname(JWT_SECRET_FILE), { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    // Windows 上 mode 基本无效，但 0400/0600 在 Linux 部署里能挡住同机其他用户读取
    try { fs.chmodSync(JWT_SECRET_FILE, 0o600); } catch { /* ignore */ }
    return true;
  } catch (e) {
    console.error(`[config] 写入 ${JWT_SECRET_FILE} 失败: ${e.message}`);
    return false;
  }
}
