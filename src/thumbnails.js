/**
 * 缩略图。
 *
 * 为什么必须有：列表页的每一张卡片原来都直接引用**原图**（/uploads/<uuid>.png）。
 * 一次列表 20 张、每张几 MB，一个页面就是几十 MB —— 而且浏览器对同一域名只有
 * 6 条连接，这 6 条被大图占满之后，**任何一次接口请求都得排队**。
 * 实测（5 Mbps 线路、24 张 1.6MB 的图）：点「登录」之后，请求在浏览器队列里
 * 等了 41.5 秒，而服务端真正处理它只用了 93 毫秒。用户看到的就是
 * 「点登录 → 处理中… → 好几秒才进去」。
 *
 * 所以缩略图不只是省流量，它同时修掉「登录慢」「点赞没反应」这类看起来
 * 毫不相关的症状：只要图片不再霸占连接，交互请求就是即时的。
 *
 * 设计要点：
 * - sharp 是**可选依赖**（optionalDependencies）。装不上、加载失败、某张图
 *   解不开，一律不做任何事地回退到原图 —— 功能绝不因它退化，只是慢一些。
 * - 缩略图按 `thumb_<原文件名去扩展名>.jpg` 存在同一个 uploads 目录里，
 *   于是静态服务、闸门、分享令牌、删图清理这几条链路全都不需要额外适配。
 * - 写入用临时文件 + rename，避免并发下读到写了一半的图。
 */
import fs from 'fs';
import path from 'path';
import { UPLOAD_DIR } from './config.js';

export const THUMB_PREFIX = 'thumb_';
const THUMB_EXT = '.jpg';

/** 最长边（不是宽）—— 网格卡片最宽也就 400 多 CSS 像素，720 在高分屏下也够看 */
const MAX_EDGE = Number(process.env.THUMB_MAX_EDGE) || 720;
const QUALITY = Number(process.env.THUMB_QUALITY) || 78;

/** 小机器上别把 CPU 打满：同时在跑的缩略图任务上限 */
const MAX_CONCURRENT = Number(process.env.THUMB_CONCURRENCY) || 2;

/** 原图可能的扩展名（上传时由文件头决定，见 routes/photos.js） */
const ORIGINAL_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];

// ---------------------------------------------------------------------------
// sharp 懒加载
// ---------------------------------------------------------------------------
let sharpPromise = null;
let sharpState = 'unknown'; // unknown | ready | unavailable

/**
 * 加载 sharp。只尝试一次；失败后永久走回退路径，不再反复 import。
 * 返回 null 表示不可用 —— 调用方必须据此回退，而不是抛错。
 */
function loadSharp() {
  if (!sharpPromise) {
    // 显式关闭（小内存机器想省 CPU / 排查问题时用）：直接按不可用处理
    if (/^(1|true|on|yes)$/i.test(String(process.env.THUMBS_DISABLED || ''))) {
      sharpState = 'unavailable';
      console.log('[thumb] THUMBS_DISABLED 已设置，缩略图关闭：列表将直接使用原图。');
      sharpPromise = Promise.resolve(null);
      return sharpPromise;
    }
    sharpPromise = import('sharp')
      .then((m) => {
        const lib = m.default;
        // 小 VPS 上把 libvips 内部线程数压到 1，避免一张图把整台机器占满
        try { lib.concurrency(1); } catch { /* 老版本没有这个方法 */ }
        // files: 0 —— 关掉「缓存已打开文件句柄」这项。
        // libvips 默认会保留最近 20 个已打开的文件句柄，在 Windows 上意味着
        // 刚生成过缩略图的那张原图**删不掉**（EBUSY/EPERM），用户看到的是
        // 「点了删除，列表里没了，磁盘上的文件还在」。我们每张图只读一次，
        // 这个缓存本来就没有价值。
        try { lib.cache({ files: 0, memory: 50, items: 100 }); } catch { /* ignore */ }
        sharpState = 'ready';
        console.log('[thumb] sharp 已加载，将生成缩略图');
        return lib;
      })
      .catch((e) => {
        sharpState = 'unavailable';
        console.warn(`[thumb] 未安装 sharp（${e.code || e.message}），缩略图不可用：列表将直接使用原图。`);
        console.warn('[thumb] 想要更快的加载速度，可在部署目录执行：npm install sharp');
        return null;
      });
  }
  return sharpPromise;
}

/** 启动时就开始加载，让日志里能立刻看到缩略图到底可用不可用 */
loadSharp();

/** 供日志/诊断使用 */
export function thumbnailStatus() {
  return sharpState;
}

// ---------------------------------------------------------------------------
// 文件名换算
// ---------------------------------------------------------------------------

/** 原图文件名 → 缩略图文件名（例：a1b2.png → thumb_a1b2.jpg） */
export function thumbNameFor(filename) {
  const base = String(filename).replace(/\.[^.]+$/, '');
  return `${THUMB_PREFIX}${base}${THUMB_EXT}`;
}

/**
 * 是否是一个缩略图请求。
 *
 * 必须严格：只接受 `thumb_<单层文件名>.jpg` 这种形状，任何带 / \ .. 的
 * 输入直接判否 —— 否则这里会变成一条读取任意文件的旁路。
 */
export function isThumbName(name) {
  const n = String(name || '');
  if (!n.startsWith(THUMB_PREFIX)) return false;
  if (n.includes('/') || n.includes('\\') || n.includes('..')) return false;
  return /^thumb_[^/\\]+\.jpe?g$/i.test(n);
}

/** 缩略图文件名 → 原图的「基名」（不含扩展名） */
export function baseOfThumb(thumbName) {
  return String(thumbName).slice(THUMB_PREFIX.length).replace(/\.[^.]+$/, '');
}

/** 按基名找回原图文件（扩展名由上传时的文件头决定，这里逐个试） */
function findOriginalByBase(base) {
  if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) return null;
  for (const ext of ORIGINAL_EXTS) {
    const p = path.join(UPLOAD_DIR, base + ext);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 试下一个 */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 同一张图的生成任务只跑一次（并发的网格请求会共用同一个 Promise） */
const inFlight = new Map();

/** 极简信号量：最多 MAX_CONCURRENT 个任务同时在跑 */
let running = 0;
const waiting = [];
function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

async function generate(sharpLib, originalPath, thumbPath) {
  const tmp = `${thumbPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await sharpLib(originalPath, { sequentialRead: true, limitInputPixels: 268402689 })
      // 手机照片的 EXIF 方向必须应用，否则竖拍的照片在网格里全是躺着的
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
      .toFile(tmp);
    fs.renameSync(tmp, thumbPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 确保某个原图有对应的缩略图。
 * 返回缩略图绝对路径；生成失败或 sharp 不可用时返回 null（调用方回退到原图）。
 */
export function ensureThumb(originalPath, originalName) {
  const thumbPath = path.join(UPLOAD_DIR, thumbNameFor(originalName));

  // 已经生成过就直接用（文件名是内容唯一的 UUID，不会被覆写）
  try {
    if (fs.statSync(thumbPath).size > 0) return Promise.resolve(thumbPath);
  } catch { /* 需要生成 */ }

  const key = thumbPath;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const sharpLib = await loadSharp();
    if (!sharpLib) return null;
    await acquire();
    try {
      // 排队期间可能已经被别的请求生成出来了
      try {
        if (fs.statSync(thumbPath).size > 0) return thumbPath;
      } catch { /* 继续生成 */ }
      await generate(sharpLib, originalPath, thumbPath);
      return thumbPath;
    } catch (e) {
      console.warn(`[thumb] 生成失败（${originalName}）: ${e.message}`);
      return null;
    } finally {
      release();
    }
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

/**
 * 处理一个 `/uploads/thumb_xxx.jpg` 请求。
 *
 * 返回 { file, fellBack }：
 *   - file     实际要发送的绝对路径
 *   - fellBack true 表示缩略图没能生成，发的是原图（此时必须用**短缓存**，
 *              否则浏览器会把几 MB 的原图按「一年不变」存下来，
 *              等 sharp 装好了也换不掉）
 * 找不到对应原图时返回 null（调用方回 404）。
 */
export async function resolveThumbRequest(thumbName) {
  const originalPath = findOriginalByBase(baseOfThumb(thumbName));
  if (!originalPath) return null;

  const generated = await ensureThumb(originalPath, path.basename(originalPath));
  if (generated) return { file: generated, fellBack: false };
  return { file: originalPath, fellBack: true };
}

/**
 * 删除某张原图对应的缩略图。
 *
 * 注意两种命名都要试：旧的 admin.js 里写的是 `thumb_` + 原文件名（保留原扩展名），
 * 而这里生成的是统一 `.jpg`。历史上可能两种都存在。
 */
export function deleteThumbFor(filename) {
  const names = [thumbNameFor(filename), `${THUMB_PREFIX}${filename}`];
  for (const n of new Set(names)) {
    try {
      const p = path.join(UPLOAD_DIR, n);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      console.warn(`[thumb] 删除缩略图失败（${n}）: ${e.message}`);
    }
  }
}

/** 上传完成后预热：不阻塞响应，失败也不影响上传结果 */
export function warmThumb(originalName) {
  const originalPath = path.join(UPLOAD_DIR, originalName);
  ensureThumb(originalPath, originalName).catch(() => { /* 已在内部记录 */ });
}
