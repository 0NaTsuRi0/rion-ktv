#!/bin/bash
# 骏耀K歌 服务端启动脚本 (Linux/macOS)

set -e

echo "============================================"
echo "  骏耀K歌 服务端 v2.0.0"
echo "============================================"
echo ""

# 切换到脚本所在目录（项目根目录）
cd "$(dirname "$0")"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[错误] 未找到 Node.js，请先安装 Node.js v24+"
    exit 1
fi

echo "[信息] Node.js 版本: $(node --version)"
echo ""

# 检查是否已安装依赖
if [ ! -d "app/docker/server/node_modules" ]; then
    echo "[信息] 首次运行，正在安装依赖..."
    echo ""
    cd server
    npm install
    cd "$(dirname "$0")"
    echo ""
    echo "[信息] 依赖安装完成!"
    echo ""
fi

# 创建运行时目录
mkdir -p data data/covers data/hls mv

# 检查 ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "[警告] ffmpeg 未在系统 PATH 中找到"
    echo "  请在 .env 文件中设置 FFMPEG_PATH 和 FFPROBE_PATH"
    echo ""
fi

# 复制 .env（如果不存在）
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[信息] 已从 .env.example 创建 .env 配置文件"
    echo "  请根据你的环境修改 .env 中的路径设置"
    echo ""
fi

echo "[启动] 正在启动 KTV 服务端..."
echo "  电视端: http://localhost:8080/tv/"
echo "  手机端: http://localhost:8080/mobile/"
echo "  管理端: http://localhost:8080/admin/"
echo "  按 Ctrl+C 停止服务"
echo ""

node server/index.js
