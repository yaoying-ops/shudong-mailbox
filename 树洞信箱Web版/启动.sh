#!/bin/sh
# 树洞信箱 Web 版 · 一键启动（Linux / macOS）
# 用法：在项目根目录执行  bash 启动.sh
set -e

cd "$(dirname "$0")/server"

echo "== 1/2 安装依赖（云端 Linux 会拉取 Linux 版 better-sqlite3）=="
npm install

echo "== 2/2 启动服务，端口 3000 =="
echo "学生端      http://localhost:3000/"
echo "心理中心端  http://localhost:3000/center"
echo "在 Cloud Studio 右侧「访问链接/端口」填 3000 即可对外访问。"
exec node server.js
