#!/bin/bash
set -e

# ==========================================
#   PicFlow 图片网站 - 一键安装脚本
#   用法:
#     curl -fsSL raw_url/install.sh | bash     (远程一键)
#     git clone 后 bash install.sh              (本地安装)
# ==========================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}     ${BOLD}PicFlow - 图片分享网站 一键安装${NC}     ${CYAN}║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
  echo ""
}

step()  { echo -e "${GREEN}[✓]${NC} $1"; }
info()  { echo -e "${YELLOW}[→]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

banner

# =============================================
# 0. 确定安装目录 & 获取源码
# =============================================

REPO_URL="https://github.com/dakerclaw/picflow.git"

# 检测是否已在 picflow 目录内
if [ -f "package.json" ] && grep -q '"picflow-server"' package.json 2>/dev/null; then
  APP_DIR=$(pwd)
  info "检测到当前目录已是 PicFlow 项目，跳过克隆"
else
  APP_DIR="${1:-$HOME/picflow}"
  if [ -d "$APP_DIR/.git" ]; then
    info "目录 $APP_DIR 已存在，执行 git pull..."
    cd "$APP_DIR"
    git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || true
  else
    info "克隆仓库到 $APP_DIR ..."
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
  fi
fi

echo ""
step "工作目录: $APP_DIR"

# =============================================
# 1. 检查/安装 Node.js
# =============================================
info "检查 Node.js 环境..."

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ]; then
    step "Node.js $(node -v) 已就绪"
  else
    warn "Node.js 版本过低 ($(node -v))，需要 >= 18"
    INSTALL_NODE=1
  fi
else
  warn "未检测到 Node.js"
  INSTALL_NODE=1
fi

if [ "$INSTALL_NODE" = "1" ]; then
  info "安装 Node.js 22.x ..."
  if command -v apt &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm nodejs npm
  else
    error "无法自动安装 Node.js，请手动安装 18+ 版本后重试"
    error "下载地址: https://nodejs.org/"
    exit 1
  fi
  step "Node.js $(node -v) 安装完成"
fi

# =============================================
# 2. 安装 npm 依赖
# =============================================
info "安装项目依赖..."
cd "$APP_DIR"
npm install --omit=dev 2>&1 | tail -3
step "依赖安装完成"

# =============================================
# 3. 配置环境变量
# =============================================
info "配置环境变量..."

if [ ! -f ".env" ]; then
  JWT_RANDOM=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > .env << EOF
PORT=3000
NODE_ENV=production
JWT_SECRET=${JWT_RANDOM}
UPLOAD_DIR=./uploads
DB_PATH=./picflow.db
EOF
  step ".env 已生成，JWT_SECRET 已随机生成"
else
  step "已存在 .env，保留现有配置"
fi

# =============================================
# 4. 创建必要目录
# =============================================
mkdir -p uploads
step "uploads/ 目录已就绪"

# =============================================
# 5. 验证前端产物
# =============================================
if [ ! -f "dist/index.html" ]; then
  warn "未找到 dist/ 前端构建产物"
  info "尝试构建前端..."
  if [ -d "../app" ]; then
    cd "$APP_DIR/../app"
    npm install 2>&1 | tail -3
    npm run build 2>&1 | tail -5
    cp -r dist "$APP_DIR/"
    cd "$APP_DIR"
    step "前端已构建并复制"
  else
    warn "未找到前端源码目录，将仅启动 API 服务（无前端页面）"
  fi
else
  step "前端构建产物已就绪"
fi

# =============================================
# 6. 启动服务
# =============================================
echo ""
echo -e "${BOLD}请选择启动方式:${NC}"
echo "  ${CYAN}1)${NC} PM2           进程守护，崩溃自动重启，开机自启 ${GREEN}(推荐)${NC}"
echo "  ${CYAN}2)${NC} systemd        系统服务，重启自动恢复"
echo "  ${CYAN}3)${NC} nohup          简单后台运行"
echo "  ${CYAN}4)${NC} 直接启动       前台运行（关闭终端即停止）"
echo "  ${CYAN}0)${NC} 跳过           仅安装，稍后手动启动"
echo ""

read -p "请输入选项 [1] " choice
choice=${choice:-1}

start_with_pm2() {
  info "使用 PM2 启动..."
  if ! command -v pm2 &>/dev/null; then
    npm install -g pm2
  fi
  pm2 delete picflow 2>/dev/null || true
  pm2 start src/index.js --name picflow
  pm2 save
  pm2 startup 2>/dev/null || warn "无法配置 PM2 开机自启（非 root 用户可能需要 sudo）"
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  PM2 启动成功！${NC}"
  echo -e "${GREEN}  查看状态: pm2 status${NC}"
  echo -e "${GREEN}  查看日志: pm2 logs picflow${NC}"
  echo -e "${GREEN}  重启服务: pm2 restart picflow${NC}"
  echo -e "${GREEN}  停止服务: pm2 stop picflow${NC}"
  echo -e "${GREEN}========================================${NC}"
}

start_with_systemd() {
  info "配置 systemd 服务..."
  NODE_BIN=$(which node)
  WHOAMI=$(whoami)

  sudo tee /etc/systemd/system/picflow.service > /dev/null << SYSTEMD
[Unit]
Description=PicFlow Image Website
After=network.target

[Service]
Type=simple
User=${WHOAMI}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
EnvironmentFile=-${APP_DIR}/.env

[Install]
WantedBy=multi-user.target
SYSTEMD

  sudo systemctl daemon-reload
  sudo systemctl enable picflow
  sudo systemctl start picflow
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  systemd 服务已启动！${NC}"
  echo -e "${GREEN}  查看状态: sudo systemctl status picflow${NC}"
  echo -e "${GREEN}  查看日志: sudo journalctl -u picflow -f${NC}"
  echo -e "${GREEN}  重启服务: sudo systemctl restart picflow${NC}"
  echo -e "${GREEN}========================================${NC}"
}

start_with_nohup() {
  nohup node src/index.js > picflow.log 2>&1 &
  PID=$!
  sleep 1
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  后台启动成功 (PID: $PID)${NC}"
  echo -e "${GREEN}  查看日志: tail -f ${APP_DIR}/picflow.log${NC}"
  echo -e "${GREEN}  停止服务: kill $PID${NC}"
  echo -e "${GREEN}========================================${NC}"
}

start_foreground() {
  echo ""
  echo -e "${GREEN}前台启动中... 按 Ctrl+C 停止${NC}"
  echo ""
  node src/index.js
}

case $choice in
  1) start_with_pm2 ;;
  2) start_with_systemd ;;
  3) start_with_nohup ;;
  4) start_foreground ;;
  0) step "安装完成，请手动启动: cd $APP_DIR && npm start" ;;
  *) start_with_pm2 ;;
esac

# =============================================
# 7. 配置防火墙（仅后台模式）
# =============================================
if [ "$choice" != "0" ] && [ "$choice" != "4" ]; then
  echo ""
  read -p "是否开放 3000 端口防火墙? [Y/n] " fw
  fw=${fw:-Y}
  if [[ "$fw" =~ ^[Yy] ]]; then
    if command -v ufw &>/dev/null; then
      sudo ufw allow 3000/tcp 2>/dev/null && step "ufw: 已开放 3000 端口" || true
    elif command -v firewall-cmd &>/dev/null; then
      sudo firewall-cmd --permanent --add-port=3000/tcp 2>/dev/null || true
      sudo firewall-cmd --reload 2>/dev/null || true
      step "firewalld: 已开放 3000 端口"
    fi
  fi
fi

# =============================================
# 完成
# =============================================
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo '你的服务器IP')

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}         ${BOLD}安装完成！${NC}                      ${CYAN}║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  访问地址: ${GREEN}http://${IP}:3000${NC}   ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  项目目录: ${APP_DIR}                    ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""
