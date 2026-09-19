/**
 * 「连接预留」脚本。
 *
 * 解决的问题：浏览器对同一域名（HTTP/1.1）只有 **6 条并发连接**。列表页一次要下
 * 20 张图，一旦把这 6 条占满，页面上**任何**接口请求都得在客户端排队 ——
 * 用户看到的是「点登录 / 点管理后台要等十几秒」，而服务端处理它只要 2 毫秒。
 *
 * 实测（Chrome + 5Mbps 限速 + 20 张 1.7MB 原图）：
 *   /api/settings（管理后台打开时第一个请求）排队 15209ms、在途 2ms
 *   → 点「管理」到设置表单可用要 15.7 秒。
 * 把列表换成缩略图后同一测试是 0.25 秒；但只要图片稍微重一点（缩略图生成失败、
 * 历史大图、弱网），这个坑就会重新出现。
 *
 * 做法：把**列表缩略图**的并发上限压到 IMAGE_CONCURRENCY（默认 4），
 * 任何时候都留至少 2 条连接给接口请求。代价是图片整体慢一点点，
 * 换来的是页面上的每一次点击都即时响应。
 *
 * 为什么只限制缩略图（`/uploads/thumb_*`）：灯箱、下载、分享页打开的都是原图，
 * 那是用户明确在等的东西，不能被列表缩略图挤在后面。
 *
 * 为什么需要 IntersectionObserver：只做并发限制会把「懒加载」变成「全部抢着下」。
 * 两者结合 = 真正按可视区域、按优先级、限量地加载。
 *
 * 安全边界：任何一步出问题（没有 IntersectionObserver、属性不可配置、运行中抛错）
 * 都立刻退回浏览器原生行为 —— 必须保证这段脚本最坏情况下等于「不存在」，
 * 而不是把图片搞得不加载。
 */

/**
 * 生成要内联进 index.html 的脚本。
 * IMAGE_CONCURRENCY <= 0 时返回空串（等于关闭）。
 */
export function imageGateScript(maxConcurrent) {
  const max = Number(maxConcurrent);
  if (!Number.isFinite(max) || max <= 0) return '';
  return `<script data-picflow="image-gate">${buildSource(Math.floor(max))}</script>`;
}

/**
 * 脚本正文。
 *
 * 注意这里是**字符串**而不是可直接执行的模块代码：它要在 index.html 里以
 * 内联脚本跑在应用 bundle 之前，必须自包含、不能引用任何外部变量。
 */
function buildSource(MAX) {
  return `(function(){
  var MAX = ${MAX};
  try {
    // HTTP/2 / HTTP/3 下所有请求复用一个连接，图片不会把接口「堵在门口」，
    // 限流只会让图片变慢 —— 这种情况直接不接管。
    // 读不到协议时按 HTTP/1.1 处理（限流的代价只是图片稍慢，不会是坏的默认）。
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      var p = nav && nav.nextHopProtocol;
      if (p === 'h2' || p === 'h2c' || p === 'h3') return;
    } catch (e2) { /* 读不到就继续，按 HTTP/1.1 处理 */ }

    var proto = window.HTMLImageElement && window.HTMLImageElement.prototype;
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc || typeof desc.set !== 'function' || !desc.configurable) return;
    var nativeSet = desc.set, nativeGet = desc.get;
    var nativeSetAttr = proto.setAttribute;

    // 只拦列表缩略图。原图（灯箱/下载/分享）不拦，那是用户明确在等的东西。
    function isThumb(v) {
      return typeof v === 'string' && v.indexOf('/uploads/thumb_') >= 0;
    }

    var busy = 0;
    var queue = [];
    var state = new WeakMap();   // el -> {url, ready, started, obs}

    var hasIO = typeof window.IntersectionObserver === 'function';
    var io = hasIO ? new IntersectionObserver(function(entries){
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        var st = state.get(e.target);
        if (!st) continue;
        io.unobserve(e.target);
        st.ready = true;
        if (!st.started) pump();
      }
    }, { rootMargin: '600px 0px' }) : null;

    function finish(el) {
      var st = state.get(el);
      if (!st || !st.started) return;
      st.started = false;
      st.timer && clearTimeout(st.timer);
      st.timer = null;
      el.removeEventListener('load', st.onDone);
      el.removeEventListener('error', st.onDone);
      el.removeEventListener('abort', st.onDone);
      if (busy > 0) busy--;
      pump();
    }

    function launch(el) {
      var st = state.get(el);
      if (!st || st.started) return;
      st.started = true;
      busy++;
      st.onDone = function(){ finish(el); };
      el.addEventListener('load', st.onDone);
      el.addEventListener('error', st.onDone);
      el.addEventListener('abort', st.onDone);
      // 兜底：万一某个浏览器不给上面三个事件，别把名额永久占死
      st.timer = setTimeout(st.onDone, 30000);
      try { nativeSet.call(el, st.url); }
      catch (err) { finish(el); }
    }

    // 按 DOM 顺序放行：上面的图片先下，符合「用户先看到上面的」直觉
    function pump() {
      while (busy < MAX) {
        var next = null;
        for (var i = 0; i < queue.length; i++) {
          var el = queue[i];
          var st = state.get(el);
          if (!st || !st.ready) continue;          // 还没进入视野，继续等
          if (st.started) { queue.splice(i, 1); i--; continue; }
          if (!el.isConnected) { queue.splice(i, 1); i--; continue; }  // 已被移除
          next = el;
          break;
        }
        if (!next) return;
        queue.splice(queue.indexOf(next), 1);
        launch(next);
      }
    }

    function accept(el, url) {
      var st = state.get(el);
      if (!st) { st = {}; state.set(el, st); }
      st.url = url;
      if (st.started) return;             // 同一张图重复赋值，不重复占名额
      if (queue.indexOf(el) < 0) queue.push(el);
      if (!st.ready) {
        if (io) {
          try { io.observe(el); } catch (err) { st.ready = true; }
          if (!st.ready) return;          // 等它进入视野
        } else {
          st.ready = true;                // 没有 IntersectionObserver，只能立即排队
        }
      }
      pump();
    }

    function route(el, value) {
      if (!isThumb(value)) { nativeSet.call(el, value); return; }
      accept(el, value);
    }

    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function(){ return nativeGet.call(this); },
      set: function(v){ route(this, v); },
    });

    // React 在某些路径下会用 setAttribute 设置 src，一并接住
    if (typeof nativeSetAttr === 'function') {
      proto.setAttribute = function(name, value) {
        if (String(name).toLowerCase() === 'src' && isThumb(value)) {
          route(this, value);
          return;
        }
        return nativeSetAttr.call(this, name, value);
      };
    }

    window.__IMG_GATE__ = {
      max: MAX,
      stats: function(){ return { busy: busy, queued: queue.length }; },
      off: function(){
        Object.defineProperty(proto, 'src', {
          configurable: true, enumerable: desc.enumerable,
          get: nativeGet, set: nativeSet,
        });
        if (typeof nativeSetAttr === 'function') proto.setAttribute = nativeSetAttr;
      },
    };
  } catch (e) { /* 出错就等于这段脚本不存在，图片走原生加载 */ }
})();`;
}
