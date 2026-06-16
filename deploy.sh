#!/bin/bash
set -e

# ==========================================
#   PicFlow - Linux 一键部署脚本
#   用法: bash deploy.sh
# ==========================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}   PicFlow 图片网站 - Linux 部署脚本   ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# ---- 检查 Node.js ----
if ! command -v node &>/dev/null; then
    echo -e "${YELLOW}未检测到 Node.js，正在安装...${NC}"
    if command -v apt &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt install -y nodejs
    elif command -v yum &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
        yum install -y nodejs
    else
        echo -e "${RED}请手动安装 Node.js 22+ 后重试${NC}"
        exit 1
    fi
fi

NODE_VER=$(node -v)
echo -e "${GREEN}Node.js 版本: ${NODE_VER}${NC}"

# ---- 安装依赖 ----
echo -e "${YELLOW}安装项目依赖...${NC}"
npm install --omit=dev

# ---- 检查前端构建产物 ----
if [ ! -d "dist" ]; then
    echo -e "${RED}错误: dist/ 目录不存在${NC}"
    echo -e "${YELLOW}请先在本地执行: cd app && npm run build && cp -r dist ../server/${NC}"
    exit 1
fi

# ---- 配置环境变量 ----
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}生成 .env 配置...${NC}"
    JWT_RANDOM=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    cat > .env << EOF
PORT=3000
NODE_ENV=production
JWT_SECRET=${JWT_RANDOM}
UPLOAD_DIR=./uploads
DB_PATH=./picflow.db
EOF
    echo -e "${GREEN}.env 已生成，JWT_SECRET 已随机生成${NC}"
else
    echo -e "${GREEN}已存在 .env 文件，跳过生成${NC}"
fi

# ---- 创建必要目录 ----
mkdir -p uploads

# ---- 选择启动方式 ----
echo ""
echo -e "${GREEN}请选择启动方式:${NC}"
echo "  1) PM2 (推荐 - 进程守护，自动重启)"
echo "  2) systemd (系统服务)"
echo "  3) nohup 后台运行"
echo "  4) 仅安装不启动"
read -p "输入选项 [1-4] (默认 1): " choice
choice=${choice:-1}

case $choice in
    1)
        echo -e "${YELLOW}使用 PM2 启动...${NC}"
        if ! command -v pm2 &>/dev/null; then
            npm install -g pm2
        fi
        pm2 delete picflow 2>/dev/null || true
        pm2 start src/index.js --name picflow --env production
        pm2 save
        pm2 startup 2>/dev/null || true
        echo -e "${GREEN}PM2 启动成功！${NC}"
        echo -e "  查看状态: pm2 status"
        echo -e "  查看日志: pm2 logs picflow"
        ;;
    2)
        echo -e "${YELLOW}配置 systemd 服务...${NC}"
        APP_DIR=$(pwd)
        NODE_BIN=$(which node)
        sudo tee /etc/systemd/system/picflow.service > /dev/null << SYSTEMD
[Unit]
Description=PicFlow Image Website
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SYSTEMD
        sudo systemctl daemon-reload
        sudo systemctl enable picflow
        sudo systemctl start picflow
        echo -e "${GREEN}systemd 服务已启动！${NC}"
        echo -e "  查看状态: sudo systemctl status picflow"
        echo -e "  查看日志: sudo journalctl -u picflow -f"
        ;;
    3)
        echo -e "${YELLOW}nohup 后台启动...${NC}"
        nohup node src/index.js > picflow.log 2>&1 &
        echo -e "${GREEN}已后台启动 (PID: $!)${NC}"
        echo -e "  查看日志: tail -f picflow.log"
        ;;
    4)
        echo -e "${GREEN}安装完成，请手动启动: npm start${NC}"
        exit 0
        ;;
esac

# ---- 配置防火墙 ----
echo ""
read -p "是否开放 3000 端口防火墙? [Y/n] " fw
fw=${fw:-Y}
if [[ "$fw" =~ ^[Yy] ]]; then
    if command -v ufw &>/dev/null; then
        sudo ufw allow 3000/tcp 2>/dev/null || true
        echo -e "${GREEN}ufw: 已开放 3000 端口${NC}"
    elif command -v firewall-cmd &>/dev/null; then
        sudo firewall-cmd --permanent --add-port=3000/tcp 2>/dev/null || true
        sudo firewall-cmd --reload 2>/dev/null || true
        echo -e "${GREEN}firewalld: 已开放 3000 端口${NC}"
    fi
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  PicFlow 部署完成！${NC}"
echo -e "${GREEN}  访问地址: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '你的服务器IP'):3000${NC}"
echo -e "${GREEN}========================================${NC}"
