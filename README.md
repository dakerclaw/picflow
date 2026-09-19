# PicFlow - 图片分享网站

一个功能完整的图片分享网站，支持瀑布流浏览、图片上传/下载、账号管理、点赞分享。

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| **瀑布流布局** | 响应式自适应 1~6 列，随窗口宽度动态调整 |
| **图片预览** | 全屏灯箱，**滚动鼠标滚轮**连续上下切换图片 |
| **多图上传** | 拖拽或点击选择，支持 JPG/PNG/GIF/WebP，单张最大 50MB |
| **账号系统** | 注册/登录，JWT 认证，个人主页管理 |
| **点赞收藏** | 一键点赞，实时计数 |
| **图片下载** | 卡片和预览页均可直接下载 |
| **图片分享** | 一键复制链接，支持微博/Twitter 分享 |
| **搜索过滤** | 按名称、标签、作者实时搜索 |
| **标签 / 作者筛选** | 顶部按钮列出全站标签与作者，点选即筛选（服务端分页） |
| **全局访问密码** | 开启后整站加密，输入密码才能浏览，支持后台随时开关/改密 |
| **响应式设计** | 桌面端/平板/手机全适配 |

## 🏗 技术栈

| 层 | 技术 |
|----|------|
| **前端** | React 18 + TypeScript + Vite + Tailwind CSS |
| **后端** | Node.js + Express |
| **数据库** | SQLite（sql.js，纯 JS 零编译依赖） |
| **认证** | JWT + bcryptjs |
| **文件上传** | multer |

## 📁 项目结构

```
picflow/
├── src/
│   ├── index.js              # Express 入口（API + 静态文件服务 + 访问密码闸门）
│   ├── database.js            # SQLite 封装
│   ├── middleware/
│   │   └── auth.js            # JWT 鉴权中间件
│   └── routes/
│       ├── auth.js            # 注册/登录/个人信息 API
│       ├── photos.js          # 图片上传/列表/点赞/删除 API
│       ├── settings.js        # 站点设置 API
│       ├── admin.js           # 管理员 API（用户管理、访问密码）
│       └── gate.js            # 全局访问密码（校验/开关/令牌）
├── dist/                      # 前端构建产物（已内置）
│   ├── gate.html              # 未解锁时展示的密码页
│   └── gate.css               # 密码页样式
├── uploads/                   # 图片文件存储目录
├── package.json
├── Dockerfile                 # Docker 镜像构建
├── docker-compose.yml         # Docker Compose 一键部署
├── deploy.sh                  # Linux 裸机部署脚本
├── install.sh                 # 一键安装脚本（从 GitHub 克隆）
├── .env.example               # 环境变量模板
└── .gitignore
```

## 🚀 一键安装

在 Linux 服务器上执行（需要 root 权限或 sudo）：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dakerclaw/picflow/main/install.sh)
```

或者克隆后手动安装：

```bash
git clone https://github.com/dakerclaw/picflow.git
cd picflow
bash install.sh
```

## 🐳 Docker 部署

```bash
git clone https://github.com/dakerclaw/picflow.git
cd picflow
docker compose up -d
```

访问 `http://服务器IP:3000`

## 🔄 更新方式

### Docker 部署更新

```bash
cd ~/picflow
git pull
docker compose down
docker compose up -d --build
```

> 数据库文件和上传的图片存储在 `data/` 和 `uploads/` 目录，更新不会丢失数据。



## 🗑 卸载方式

### Docker 卸载

```bash
docker compose down --rmi all --volumes
cd ..
rm -rf picflow
```

> `--rmi all` 删除镜像，`--volumes` 删除数据卷。**此操作会删除所有图片和数据库，请提前备份！**



## 🔧 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `NODE_ENV` | `production` | 运行环境 |
| `JWT_SECRET` | `change-me-...` | JWT 签名密钥，**务必修改** |
| `UPLOAD_DIR` | `./uploads` | 图片存储目录 |
| `DB_PATH` | `./picflow.db` | SQLite 数据库路径 |

## 🔐 全局访问密码

开启后，**整站加密**：未通过验证的访客只能看到一个密码输入页，图片列表、图片文件、上传等接口一律拒绝访问。

### 如何开启

1. 用管理员账号登录（第一个注册的账号自动成为管理员）
2. 点击顶部导航的 **管理** 按钮进入管理后台
3. 切到 **🔐 访问密码** 页签
4. 打开开关、设置密码（可选填提示语、调整有效期），点 **保存设置**，**立即生效**（无需重启服务）

> **默认关闭**：全新安装时整站是公开的，不需要任何操作；只有管理员主动打开开关后才会要求输入密码。
>
> 关闭开关即可恢复公开访问，密码本身会保留，重新打开开关无需再设一次。
>
> 开启保护前必须先设置密码：若开关已打开但没有密码，前端会提示「请先设置访问密码」，服务端也会拒绝该请求，避免出现「显示已开启、实际仍可匿名访问」的假成功状态。

管理接口：

```bash
# 开启并设置密码
curl -X PUT http://localhost:3000/api/admin/site-password \
  -H "Authorization: Bearer <管理员JWT>" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"password":"你的密码","hint":"请输入访问密码","sessionHours":12}'

# 关闭
curl -X PUT http://localhost:3000/api/admin/site-password \
  -H "Authorization: Bearer <管理员JWT>" \
  -H "Content-Type: application/json" -d '{"enabled":false}'
```

### 行为说明

| 项目 | 说明 |
|------|------|
| **保护范围** | 前端页面、全部 API、`/uploads` 图片文件、前端 JS/CSS 构建产物，一律拦截 |
| **放行内容** | 仅密码页本身及其样式 `gate.css`、**分享页 `/share/*`**；以及**已解锁访客**（Cookie / 令牌）携带的构建产物请求、**分享令牌**授权的那一张图片文件 |
| **有效期** | 令牌存于 `sessionStorage` **与** `picflow_site_token` 会话 Cookie，**关闭浏览器即失效**，需重新输入 |
| **令牌时效** | 服务端签发时默认 12 小时，可在后台调整（`sessionHours`） |
| **防爆破** | 同一 IP 10 分钟内连续输错 10 次，锁定 10 分钟 |
| **缓存** | 锁定状态下所有响应带 `no-store`，不在浏览器留下受保护内容的副本 |
| **令牌传递** | 页面与 API 走 `X-Site-Token` 请求头；图片等无法自定义头的资源走 `?site_token=` 参数；浏览器自动发起的 `<script>`/`<link>` 请求走 `picflow_site_token` Cookie |
| **管理员豁免** | 锁定状态下，持有**合法管理员 JWT** 的请求仍可访问 `/api/admin/site-password`，避免「改不了密码 / 关不掉闸门」的死锁；其余管理员接口与普通用户一样被拦截 |

> **为什么需要 Cookie**：入口页里的 `<script src="/assets/index-xxx.js">` 与 `<link href="...css">`
> 是**浏览器自己**发起的请求，前端 JS 既加不了请求头，也拼不了查询参数。若这类请求也被要求令牌，
> 就会表现为「密码输对了、也跳转了，但页面全白」——因为 JS/CSS 拿到 401，应用根本没跑起来。
> 解锁时服务端会同时种下 `picflow_site_token` Cookie（会话级、`SameSite=Lax`），
> 浏览器自动携带，正好覆盖这类请求。前端仍会读 `sessionStorage` 拼图片 URL，
> 两条路互相独立、都可单独生效。
>
> **入口页资源必须用绝对路径**：`dist/index.html` 里的资源引用必须是 `/assets/...`，
> 不能是 `./assets/...`。否则访问 `/admin` 这类 SPA 深链时，浏览器会把它解析成
> `/admin/assets/...`，拿到的是 HTML 兜底页而不是 JS（MIME 错误）→ 同样白屏。

> 管理员豁免只对「管理访问密码」这一个接口生效，且服务端会重新查库确认 `is_admin`（不信任令牌里的声明）。被禁用的账号即使自称管理员也不豁免。

### 密码接口

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/gate/status` | 公开 | 查询加密状态与是否已解锁 |
| POST | `/api/gate/unlock` | 公开 | 提交密码换取访问令牌，**并种下 `picflow_site_token` Cookie** |
| GET | `/api/admin/site-password` | 管理员 | 读取加密设置（不含密码明文）。**锁定状态下仍可访问** |
| PUT | `/api/admin/site-password` | 管理员 | 修改密码 / 开关 / 提示语 / 有效期。**锁定状态下仍可访问**。`enabled:true` 时若此前未设置过密码且本次也没带 `password`，返回 400 |

> 访问令牌可通过三种方式提交，任一有效即可：`X-Site-Token` 请求头、`?site_token=` 查询参数、
> `picflow_site_token` Cookie。
>
> `hint` 留空表示密码页不显示提示语。默认值 `请输入访问密码` 会被视作「未设置」。

### 🔗 分享链接与整站密码（重要）

开启整站密码后，**分享出去的单张照片链接依然可以免密访问**，不会被密码页拦住。

原理是分享链接自带一个**只授权这一张照片**的窄令牌，与站点通行证完全隔离：

| 项 | 说明 |
|------|------|
| **链接形态** | `/share/<photoId>?t=<shareToken>` |
| **令牌作用域** | `scope=share` 且绑定 `photoId`，**只能看这一张**，不能当站点通行证用 |
| **令牌来源** | 服务端签发，随 `/api/photos`、`/api/photos/mine`、`/api/photos/:id` 的每条记录以 `share_token` 字段下发 |
| **有效期** | 3650 天（长期有效，与常见图床行为一致）；删除照片后链接立即失效（404） |
| **渲染方式** | 服务端渲染的独立页面 `dist/share.html`，**不加载 SPA bundle**，也不开放任何站内 API |
| **图片放行** | `/uploads/<file>` 仅在携带的 `share_token` 所绑定的照片文件名**正好等于**被请求文件名时放行 |

> **为什么不用 SPA 承载分享页**：整站加密时把未解锁访客放进 SPA，等于让 bundle 直接去请求
> `/api/photos` 等受保护接口，结果必然是一片空白或 401。所以分享页由服务端一次性渲染好，
> 只暴露这一张照片，其余内容一律不碰。

> **为什么分享令牌不能当通行证**：如果分享链接里塞的是站点令牌，那么任何收到链接的人
> 都能借此浏览整站 —— 分享功能就等价于把密码告诉了所有人。因此 `isShareTokenValidFor`
> 会同时校验 `scope === 'share'` 与 `photoId` 完全相等，两者缺一不可。

### ⚠️ 忘记密码怎么办

密码以 bcrypt 哈希存储，无法反推，只能重置。

> **先搞清楚改动该落在哪**：站点设置真正生效的位置是**数据库**
> （`data/picflow.db` 的 `settings` 表）。`data/settings.json` 只是导出备份，
> **改它或删它都不会改变站点行为**，重启也无效。

**推荐做法：清掉数据库里的密码设置**

```bash
cd <项目目录>/server
docker compose stop                    # 先停容器，避免它把内存里的旧数据写回文件

docker compose run --rm picflow node --input-type=module -e "
import db from './src/database.js';
const r = db.prepare(\"DELETE FROM settings WHERE key IN ('site_password_hash','site_password_enabled')\").run();
db.save(); console.log('deleted rows =', r.changes);"

docker compose start                   # 闸门回到默认的「关闭」状态
```

只删这两行，其他站点设置与所有照片都不受影响。重启后直接访问站点，
再进「管理后台 → 站点设置」重新设一个新密码即可。

> `docker compose run --rm picflow …` 会用同一套挂载卷（`./data`、`./uploads`）
> 跑一个一次性容器来执行这段脚本，跑完即销毁，不碰照片数据。

**另一种情况：浏览器里还留着管理员登录态。**
闸门对管理员令牌放行（否则会出现「管理员没解锁 → 改不掉密码 / 关不掉闸门」的死锁），
所以可以直接请求 `PUT /api/admin/site-password`，请求体 `{"enabled":false}`；
令牌在 DevTools → Application → Local Storage 里找。

> 服务器上若装有 `sqlite3` 命令行，也可以直接改这个文件
> （`data/picflow.db` 是标准 SQLite 格式）：
> `sqlite3 data/picflow.db "DELETE FROM settings WHERE key IN ('site_password_hash','site_password_enabled');"`
> —— 同样要先 `docker compose stop`。

### ⚠️ 输入密码后页面空白

按顺序排查：

1. **浏览器 Console 是否报 401**（`/assets/*.js` 或 `/assets/*.css`）。
   若是，说明静态资源守卫没放行 —— 检查 `gateGuardAssets` 是否调用了
   `verifyGateTokenAny`（要认 Cookie），以及 `gate.html` 里解锁后是否真的跳转了。
2. **Application → Cookies 里有没有 `picflow_site_token`**。
   没有说明 `POST /api/gate/unlock` 的响应没带 `Set-Cookie`，
   通常是中间件或反向代理把 Cookie 头吞了。
3. **Network 里 JS 请求的 URL 是不是 `/admin/assets/...` 这种畸形路径**。
   是则说明 `dist/index.html` 用了 `./assets/...` 相对路径，
   必须改成 `/assets/...`。
4. 反向代理（Nginx）注意放行 `Set-Cookie` 与 `Cookie` 头，不要做 `proxy_cookie_path` 之类的改写。

### ⚠️ 开启密码后，分享出去的照片打不开

分享功能与整站密码是**两套独立机制**，用这套顺序定位：

1. **链接里 `?t=` 后面是不是空的？**
   若形如 `/share/<id>?t=`，说明前端没拿到 `share_token`。
   先确认接口返回里有没有这个字段：`curl -H "Authorization: Bearer <token>" /api/photos`。
   没有 → 后端没签发（检查 `routes/photos.js` 的 `withShareToken` 是否接到了所有读取分支，
   包括**上传接口的返回**）；有字段但前端是空 → 前端把字段洗掉了
   （`co()` 这类 view-model 转换必须显式保留 `shareToken`）。
2. **打开链接看到「链接无效或已失效」？**
   说明令牌验签失败或与 `photoId` 不匹配。检查 `JWT_SECRET` 是否在两次部署间变过
   （变了会导致**已发出的所有旧链接一起失效**），以及链接里的 id 是否就是令牌绑定的那张。
3. **照片区域空白，但页面框架正常？**
   说明 HTML 出来了、`<img>` 被挡了。检查 `gateGuardUploads` 里 `shareTokenCoversFile`
   是否真的比对上了文件名（它拿令牌里的 `photoId` 反查 `photos.filename`）。
4. **接收者被丢回密码页？**
   说明 `/share` 的豁免中间件没生效。它必须挂在**所有闸门之前**，并且顺手打上
   `req.__gatePassed = true` —— 只 `next()` 是不够的，后面的守卫仍会拦住。

### ⚠️ 上传提示「上传成功」，但图片不在列表里 / 标签没保存

先看弹窗底部的提示：新版失败时**不会关闭弹窗**，红色提示里就是服务端的真实原因。

1. **提示「上传失败：保存图片信息失败：…」** → 数据库写入失败。
   看 `docker compose logs -f`，日志里有 `[photos] 入库失败（tags=…）`。
   常见原因是 `data/` 挂载卷不可写或磁盘写满。
2. **弹窗显示「✓ 上传成功」但照片没带上标签** → 服务端很可能还在跑旧代码。
   前端 bundle 由 `express.static` 直接从磁盘读，`git pull` 后**不重启进程**
   就会变成「新前端 + 旧后端」：旧后端不认识 `tags` 字段，静默丢弃。
   确认方式：打开页面顶部的「标签」按钮，若候选是空的，
   说明 `/api/photos/facets` 不存在 —— 服务端确实没更新。
   处理：`docker compose up -d --build`（或重启 node 进程）。
3. **提示「请求失败（HTTP 500，服务端返回了非 JSON 内容）」** → 后端抛了未捕获异常。
   现在的代码已把所有错误统一成 JSON，出现这句说明服务端也是旧版本，同样按第 2 条处理。

## 📡 API 文档

### 认证

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/auth/register` | 注册 | - |
| POST | `/api/auth/login` | 登录 | - |
| GET | `/api/auth/me` | 获取当前用户 | ✅ |
| PUT | `/api/auth/me` | 更新个人资料 | ✅ |

### 图片

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/photos` | 图片列表（`?search=&year=&month=&day=&page=&limit=`，默认 `page=1&limit=20`，`limit` 上限 100；返回 `total`/`totalPages`），每条记录带 `share_token` | - |
| GET | `/api/photos/mine` | 我的图片，每条记录带 `share_token` | ✅ |
| GET | `/api/photos/:id` | 图片详情，带 `share_token` | - |
| POST | `/api/photos` | 上传图片（form-data `files`），返回的记录带 `share_token` | ✅ |
| POST | `/api/photos/:id/like` | 点赞/取消点赞 | ✅ |
| POST | `/api/photos/:id/download` | 记录下载 | - |
| DELETE | `/api/photos/:id` | 删除图片（分享链接随之失效） | ✅ |

### 分享页

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/share/:id?t=<shareToken>` | 服务端渲染的单张照片分享页 | 分享令牌 |

> 分享令牌无效 / 不匹配该照片 → `403`（「链接无效」页）；照片已被删除 → `404`（「照片不存在」页）。
> 分享页自身带 `no-store`，不加载 SPA bundle，也不会把站点令牌写进页面。



## 🖥 使用指南

### 浏览图片
- 首页展示瀑布流
- 顶部搜索框可按名称/标签/作者实时筛
- 搜索框下方有「标签」「作者」两个按钮，点开即可看到**全站所有标签 / 所有作者**（带图片数量），点选即筛选，再点一次取消；也可用「清除筛选」一键回到全部
- 灯箱里会显示当前照片的标签

### 🏷 标签与作者筛选

标签在**上传时可选填写**（留空即不设标签），存为 JSON 数组文本（如 `["风景","人像"]`）。

- 上传弹窗里有「标签（可选）」输入框，多个标签用逗号分隔（中英文逗号、分号、空格都行）
- 服务端会做归一化：去首尾空格、去重、去掉引号、单个标签最多 24 字、最多 20 个
- 顶部筛选按钮的候选列表来自 `GET /api/photos/facets`，**一次拿全站**，
  不受「当前只加载了 20 张」影响
- 筛选是**服务端筛选 + 分页**的，所以选了某个标签后翻页只在这个标签的结果里翻
  （`GET /api/photos?tag=风景&page=2`）
- 标签用 `LIKE '%"风景"%'` 精确匹配整段，避免「风景」误命中「风景照」；
  匹配用的 `%` `_` 会被转义（`ESCAPE '\'`），所以标签名里带这些符号也不会串味

### 预览图片
1. 点击图片进入全屏灯箱
2. **滚动鼠标滚轮**连续上下切换图片
3. 按 ESC 或点击 X 关闭

### 上传图片
1. 注册/登录账号
2. 点击右上角「上传」按钮
3. 拖拽或点击选择图片（支持多选）
4. **（可选）在「标签」输入框填写标签**，多个用逗号分隔；留空则不设标签
5. 点击「上传」确认

**成功与失败都会如实反馈**：只有服务端确认写入成功（HTTP 201）才会显示「✓ 上传成功」并关闭弹窗，
同时清空标签输入框（避免下一批被悄悄打上上一批的标签）。
失败时弹窗**不会关闭**，已选文件与标签都保留，底部弹出一条红色提示，
内容就是服务端的真实原因（例如「保存图片信息失败：…」），可直接重试。

> 上传接口的任何错误都以 JSON 返回（包括尺寸超限、格式不符、数据库写入失败），
> 不会出现 HTML 错误页——那样前端只能看到一句毫无关系的 JSON 解析错误。

### 账号管理
- 注册：点击右上角「注册」
- 登录：点击右上角「登录」
- 个人主页：登录后点击头像
- 退出：个人主页 → 退出登录

### 分享
- 点开照片 → 点击灯箱里的「分享」按钮
- 弹窗里可复制链接、或一键分享到微信/微博/Twitter
- 链接形如 `/share/<photoId>?t=<shareToken>`，**接收者无需输入站点密码即可查看这一张**
- 对方只能看到这一张照片，站内其余内容仍需密码

### 深链（直接打开某张照片）
- 在站内使用 `/?photo=<photoId>` 可让应用启动后**自动展开这张照片的灯箱**
- 刷新后依然生效；若该照片不在已加载的列表中，应用会**自动继续翻页**去把它找出来
- 处于搜索/筛选状态时不强行展开（避免索引错位打开成别的照片）

### 📄 列表分页

首页默认一次加载 **20 张**，网格下方出现「加载更多」按钮，点击即追加下一页；
全部加载完后按钮自动消失。

- 请求形如 `GET /api/photos?page=2&limit=20`，`limit` 上限 100
- 返回 `{ photos, total, page, totalPages }`，按钮显隐由 `page < totalPages` 决定
- 追加时按 `id` **去重**，即使服务端排序抖动也不会出现重复卡片
- 切换搜索词或标签/作者筛选时，会**重置回第 1 页**（替换而非追加）
- 新加载的一页会作为**一整块出现在已有内容下方**（向下生长，不会挤进右侧列）
- 搜索时顶部显示的 `搜索 "xx" 共 N 条结果`，`N` 取自服务端 `total`（**真实命中总数**），
  不是当前已加载的条数；若 `N` 超过已加载张数，会补一句「已显示 M 张，可继续加载」

> **为什么服务端排序要带 `id` 兜底**：`created_at` 只精确到秒（`datetime('now')`），
> 批量上传会在同一秒写入几十行。只按 `created_at DESC` 排序时，同秒行的顺序在
> SQLite 里没有定义，翻页边界可能漂移，导致**某些照片重复出现、另一些永远看不到**。
> 排序键因此写成 `ORDER BY created_at DESC, id DESC`，让全序稳定。

> **为什么每页要渲染成独立的网格块**：照片网格是 CSS 多列瀑布流
> （`columnCount` + `columnFill:"balance"`）。`balance` 会以**容器高度**为基准把内容
> 均分到各列，新照片追加进同一个容器时，浏览器不会让容器变高，而是把新项填进较短的列，
> 视觉上表现为「只在右侧一两列继续加」而不是向下生长。
> 因此渲染时按 20 张一页切片，**每页各自成一个多列容器**（块块纵向排列），
> 新页自然出现在旧页下方。切片的代价是点击索引会变成「页内下标」，
> 所以传 `offset` 给网格组件，点击时补回全量下标，灯箱才不会打开成别的照片。


## 📄 License

MIT
