#!/usr/bin/env bash
# 纯 Python 电台 · 外网穿透一键脚本
# 在 G:\radio 目录下运行： bash expose.sh
# 脚本会：① 确认电台服务在 8000 端口运行（没有就启动）
#         ② 自动选用 ngrok / cloudflared 打通外网，并把公网地址写回 public_url.txt
#            控制面板会轮询该文件，自动显示可复制的分享地址（Ctrl+C 停止后自动清理）

PORT=8000
cd "$(dirname "$0")" || exit 1

PUBLIC_URL_FILE="public_url.txt"

# 退出时清理公网地址文件，避免面板显示已失效的旧地址
cleanup() { rm -f "$PUBLIC_URL_FILE"; }
trap cleanup EXIT

echo "============================================"
echo "   📻 纯 Python 电台 · 外网穿透一键脚本"
echo "============================================"

# 1) 确认本地电台服务在运行
echo "[1/2] 检查本地电台服务 (localhost:$PORT) ..."
if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" | grep -q 200; then
  echo "   电台服务已在运行 ✓"
else
  echo "   未运行，正在启动电台服务 ..."
  nohup python run.py > radio_server.log 2>&1 &
  sleep 3
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" | grep -q 200; then
    echo "   电台服务启动成功 ✓"
  else
    echo "   [!] 电台服务启动失败，请先确认依赖已装： pip install -r requirements.txt"
    exit 1
  fi
fi

# 2) 打通外网并回写公网地址
echo "[2/2] 启动外网穿透 ..."
if command -v ngrok >/dev/null 2>&1; then
  echo "   检测到 ngrok，正在建立隧道 ..."
  echo "   （若提示需要 authtoken，先执行： ngrok config add-authtoken 你的TOKEN ）"
  ngrok http "$PORT" > ngrok.log 2>&1 &
  NGROK_PID=$!
  for i in $(seq 1 30); do
    u=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
        | grep -o '"public_url":"[^"]*"' | head -1 | sed 's/"public_url":"//; s/"//')
    if [ -n "$u" ]; then printf '%s\n' "$u" > "$PUBLIC_URL_FILE"; echo "   公网地址： $u"; break; fi
    sleep 1
  done
  echo "   （Ctrl+C 停止穿透，面板会自动隐藏分享地址）"
  wait "$NGROK_PID"
elif command -v cloudflared >/dev/null 2>&1; then
  echo "   检测到 cloudflared，正在建立隧道 ..."
  cloudflared tunnel --url "http://localhost:$PORT" > cloudflared.log 2>&1 &
  CF_PID=$!
  for i in $(seq 1 30); do
    u=$(grep -o 'https://[a-z0-9.-]*\.trycloudflare\.com' cloudflared.log 2>/dev/null | head -1)
    if [ -n "$u" ]; then printf '%s\n' "$u" > "$PUBLIC_URL_FILE"; echo "   公网地址： $u"; break; fi
    sleep 1
  done
  echo "   （Ctrl+C 停止穿透，面板会自动隐藏分享地址）"
  wait "$CF_PID"
else
  echo "   [!] 未检测到 ngrok 或 cloudflared，无法一键穿透。"
  echo "   请安装其一后重跑本脚本："
  echo "     · ngrok:       https://ngrok.com/download   （装后： ngrok config add-authtoken <TOKEN>）"
  echo "     · cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install/"
  echo "   打通后，把公网地址的 /stream 发给朋友即可收听，例如："
  echo "     https://xxxx.trycloudflare.com/stream   或   https://xxxx.ngrok.io/stream"
  exit 1
fi
