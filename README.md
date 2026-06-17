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
│   ├── index.js              # Express 入口（API + 静态文件服务）
│   ├── database.js            # SQLite 封装
│   ├── middleware/
│   │   └── auth.js            # JWT 鉴权中间件
│   └── routes/
│       ├── auth.js            # 注册/登录/个人信息 API
│       └── photos.js          # 图片上传/列表/点赞/删除 API
├── dist/                      # 前端构建产物（已内置）
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

## 📦 手动部署

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 修改 JWT_SECRET

# 创建必要目录
mkdir -p uploads

# 启动服务
npm start
```

## 🔧 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `NODE_ENV` | `production` | 运行环境 |
| `JWT_SECRET` | `change-me-...` | JWT 签名密钥，**务必修改** |
| `UPLOAD_DIR` | `./uploads` | 图片存储目录 |
| `DB_PATH` | `./picflow.db` | SQLite 数据库路径 |

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

### 示例

```bash
# 注册
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","email":"demo@pic.com","password":"123456"}'

# 登录
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@pic.com","password":"123456"}'

# 上传图片
curl -X POST http://localhost:3000/api/photos \
  -H "Authorization: Bearer <token>" \
  -F "files=@photo1.jpg" \
  -F "files=@photo2.png"

# 获取图片列表
curl http://localhost:3000/api/photos?search=风景&page=1&limit=20
```

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
