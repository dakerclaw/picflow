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
| **搜索过滤** | 按标题、标签、作者实时搜索 |
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

安装脚本会自动完成：
1. 检测并安装 Node.js 22+
2. 安装 npm 依赖
3. 生成 `.env` 配置（JWT 密钥随机生成）
4. 创建上传目录和数据库
5. 引导选择启动方式（PM2 / systemd / nohup）
6. 配置防火墙

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

### PM2 部署更新

```bash
cd ~/picflow
git pull
npm install
pm2 restart picflow
```

### systemd 部署更新

```bash
cd ~/picflow
git pull
npm install
sudo systemctl restart picflow
```

### nohup 部署更新

```bash
cd ~/picflow
git pull
npm install
kill $(pgrep -f "node src/index.js")
nohup npm start > picflow.log 2>&1 &
```

## 🗑 卸载方式

### Docker 卸载

```bash
docker compose down --rmi all --volumes
cd ..
rm -rf picflow
```

> `--rmi all` 删除镜像，`--volumes` 删除数据卷。**此操作会删除所有图片和数据库，请提前备份！**

### PM2 卸载

```bash
pm2 stop picflow
pm2 delete picflow
cd ..
rm -rf picflow
```

### systemd 卸载

```bash
sudo systemctl stop picflow
sudo systemctl disable picflow
sudo rm /etc/systemd/system/picflow.service
sudo systemctl daemon-reload
cd ..
rm -rf picflow
```


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
| **放行内容** | 仅密码页本身及其样式 `gate.css`；以及**已解锁访客**（Cookie / 令牌）携带的构建产物请求 |
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

### ⚠️ 忘记密码怎么办

密码以 bcrypt 哈希存储，无法找回，只能重置。任选一种：

```bash
# 方式一：删除 settings.json 里的两个键后重启服务
#   site_password_hash
#   site_password_enabled

# 方式二：直接删除 settings.json（会一并重置其他站点设置）
rm settings.json && pm2 restart picflow
```

> Docker 部署时 `settings.json` 位于 `data/` 目录（已挂载为数据卷）。

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
| GET | `/api/photos` | 图片列表（`?search=&page=&limit=`） | - |
| GET | `/api/photos/mine` | 我的图片 | ✅ |
| GET | `/api/photos/:id` | 图片详情 | - |
| POST | `/api/photos` | 上传图片（form-data `files`） | ✅ |
| POST | `/api/photos/:id/like` | 点赞/取消点赞 | ✅ |
| POST | `/api/photos/:id/download` | 记录下载 | - |
| DELETE | `/api/photos/:id` | 删除图片 | ✅ |



## 🖥 使用指南

### 浏览图片
- 首页展示瀑布流，支持滚动加载
- 顶部搜索框可按标题/标签/作者实时筛

### 预览图片
1. 点击图片进入全屏灯箱
2. **滚动鼠标滚轮**连续上下切换图片
3. 按 ESC 或点击 X 关闭

### 上传图片
1. 注册/登录账号
2. 点击右上角「上传」按钮
3. 拖拽或点击选择图片（支持多选）
4. 点击「上传」确认

### 账号管理
- 注册：点击右上角「注册」
- 登录：点击右上角「登录」
- 个人主页：登录后点击头像
- 退出：个人主页 → 退出登录

### 分享
- 点击图片卡片上的分享图标
- 复制链接或一键分享到微博/Twitter

## 🛠 本地开发

### 前端开发

```bash
cd app
npm install
npm run dev        # 启动 Vite 开发服务器
```

### 后端开发

```bash
npm install
npm run dev        # 启动 Node.js 开发服务器
```

> 前端 dev server 已配置 proxy，`/api` 和 `/uploads` 请求自动转发到 `http://localhost:3001`

## 📄 License

MIT
