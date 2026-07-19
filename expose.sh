#!/usr/bin/env bash
# 纯 Python 电台 · 外网穿透一键脚本（D3 增强：硬路径 + 双模式 + 守护重启 + ngrok failover）
#
# 用法：
#   bash expose.sh                 # 默认 quick 模式（trycloudflare 临时域名，零配置）
#   bash expose.sh named <域名>    # named tunnel 持久化自定义域名（需 cloudflared 登录 + 域名在 CF）
#                                   # 例：bash expose.sh named radio.example.com
#   bash expose.sh ngrok           # 强制用 ngrok（failover / 备用）
#
# 特性：
#   ① 优先用本地 D:/cloudflared/cloudflared-windows-amd64.exe（不依赖 PATH）
#   ② quick 模式拿 trycloudflare 临时域名；named 模式建持久隧道 + DNS 路由
#   ③ 隧道进程退出后自动重启（quick 模式重新解析新域名回写面板）
#   ④ cloudflared 不可用时自动降级到 ngrok（D:/cloudflared/ngrok-v3-stable-windows-amd64/）
#   ⑤ 公网地址实时写回 public_url.txt，控制面板轮询自动显示

PORT=8000
cd "$(dirname "$0")" || exit 1

PUBLIC_URL_FILE="public_url.txt"
MODE="${1:-quick}"
NAMED_DOMAIN="$2"

# ---- 二进制定位：硬路径优先，PATH 兜底 ----
CF_DIR="D:/cloudflared"
CF_BIN=""
if [ -x "$CF_DIR/cloudflared-windows-amd64.exe" ]; then
  CF_BIN="$CF_DIR/cloudflared-windows-amd64.exe"
elif command -v cloudflared >/dev/null 2>&1; then
  CF_BIN="cloudflared"
fi

NGROK_BIN=""
for cand in "$CF_DIR/ngrok-v3-stable-windows-amd64/ngrok.exe" \
           "$CF_DIR/ngrok-v3-stable-windows-amd64/ngrok" \
           "$(command -v ngrok 2>/dev/null)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then NGROK_BIN="$cand"; break; fi
done

cleanup() { rm -f "$PUBLIC_URL_FILE"; }
trap cleanup EXIT

echo "============================================"
echo "   📻 纯 Python 电台 · 外网穿透（D3 增强）"
echo "============================================"
echo "   模式： $MODE"
[ -n "$CF_BIN" ]    && echo "   cloudflared： $CF_BIN"    || echo "   cloudflared： 未检测到"
[ -n "$NGROK_BIN" ] && echo "   ngrok：       $NGROK_BIN" || echo "   ngrok：       未检测到"
echo "--------------------------------------------"

# 1) 确认本地电台服务在运行
echo "[1/2] 检查本地电台服务 (localhost:$PORT) ..."
if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q 200; then
  echo "   电台服务已在运行 ✓"
else
  echo "   未运行，正在启动电台服务 ..."
  nohup python run.py > radio_server.log 2>&1 &
  sleep 3
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q 200; then
    echo "   电台服务启动成功 ✓"
  else
    echo "   [!] 电台服务启动失败，请先确认依赖已装： pip install -r requirements.txt"
    exit 1
  fi
fi

# 2) 打通外网
echo "[2/2] 启动外网穿透 ..."

# 写回公网地址（变更时才写，减少面板抖动）
write_url() {
  local u="$1"
  [ -z "$u" ] && return
  local old=""
  [ -f "$PUBLIC_URL_FILE" ] && old=$(cat "$PUBLIC_URL_FILE" 2>/dev/null)
  if [ "$u" != "$old" ]; then
    printf '%s\n' "$u" > "$PUBLIC_URL_FILE"
    echo "   ✎ 公网地址已回写面板： $u"
  fi
}

# ---- cloudflared quick tunnel（trycloudflare 临时域名）----
cf_quick() {
  [ -z "$CF_BIN" ] && return 1
  echo "   [cloudflared] 建立 quick tunnel（trycloudflare 临时域名）..."
  while true; do
    rm -f cloudflared.log
    "$CF_BIN" tunnel --url "http://localhost:$PORT" --no-autoupdate > cloudflared.log 2>&1 &
    local pid=$!
    local url=""
    for i in $(seq 1 30); do
      url=$(grep -o 'https://[a-z0-9.-]*\.trycloudflare\.com' cloudflared.log 2>/dev/null | head -1)
      [ -n "$url" ] && break
      sleep 1
    done
    if [ -n "$url" ]; then
      write_url "$url"
      echo "   [cloudflared] 隧道已建立，Ctrl+C 停止（退出后自动清理公网地址）"
      wait "$pid" 2>/dev/null
    else
      echo "   [cloudflared] 30s 内未拿到域名，日志末尾："; tail -3 cloudflared.log 2>/dev/null
    fi
    # 进程退出（网络抖动/被 kill）→ 等 3s 重启，重新解析新域名
    echo "   [cloudflared] 隧道退出，3s 后自动重启 ..."
    rm -f "$PUBLIC_URL_FILE"
    sleep 3
  done
}

# ---- cloudflared named tunnel（持久化自定义域名）----
cf_named() {
  [ -z "$CF_BIN" ] && return 1
  if [ -z "$NAMED_DOMAIN" ]; then
    echo "   [!] named 模式需提供域名： bash expose.sh named radio.example.com"
    return 1
  fi
  echo "   [cloudflared] named tunnel 模式，目标域名： $NAMED_DOMAIN"
  echo "   （首次需登录： $CF_BIN tunnel login ；域名须已托管在 Cloudflare）"
  # 创建持久隧道（已存在则复用）
  "$CF_BIN" tunnel list 2>/dev/null | grep -q '\bradio\b' || "$CF_BIN" tunnel create radio 2>&1 | tail -3
  # 写 config.yml（指向本地服务）
  cat > "$CF_DIR/config.yml" <<EOF
tunnel: radio
credentials-file: $CF_DIR/.cloudflared/radio.json
ingress:
  - hostname: $NAMED_DOMAIN
    service: http://localhost:$PORT
  - service: http_status:404
EOF
  # DNS 路由（CNAME 指向隧道）
  "$CF_BIN" tunnel route dns radio "$NAMED_DOMAIN" 2>&1 | tail -2
  write_url "https://$NAMED_DOMAIN"
  echo "   [cloudflared] named tunnel 已建立，Ctrl+C 停止"
  while true; do
    "$CF_BIN" tunnel run radio --config "$CF_DIR/config.yml" --no-autoupdate > cloudflared.log 2>&1
    echo "   [cloudflared] named tunnel 退出，3s 后自动重启 ..."
    sleep 3
  done
}

# ---- ngrok（failover / 强制）----
ngrok_tunnel() {
  [ -z "$NGROK_BIN" ] && return 1
  echo "   [ngrok] 建立隧道（若需 authtoken： $NGROK_BIN config add-authtoken <TOKEN>）"
  while true; do
    rm -f ngrok.log
    "$NGROK_BIN" http "$PORT" --log=stdout > ngrok.log 2>&1 &
    local pid=$!
    local url=""
    for i in $(seq 1 30); do
      url=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
            | grep -o '"public_url":"[^"]*"' | head -1 | sed 's/"public_url":"//; s/"//')
      [ -n "$url" ] && break
      sleep 1
    done
    if [ -n "$url" ]; then
      write_url "$url"
      echo "   [ngrok] 隧道已建立，Ctrl+C 停止"
      wait "$pid" 2>/dev/null
    else
      echo "   [ngrok] 30s 内未拿到域名，日志末尾："; tail -3 ngrok.log 2>/dev/null
    fi
    echo "   [ngrok] 隧道退出，3s 后自动重启 ..."
    rm -f "$PUBLIC_URL_FILE"
    sleep 3
  done
}

# ---- 调度 ----
case "$MODE" in
  quick)
    cf_quick || ngrok_tunnel || { echo "   [!] cloudflared 与 ngrok 均不可用，请装其一。"; exit 1; }
    ;;
  named)
    cf_named || { echo "   [!] named 模式失败，降级 quick"; cf_quick || ngrok_tunnel; }
    ;;
  ngrok)
    ngrok_tunnel || { echo "   [!] ngrok 不可用，降级 cloudflared quick"; cf_quick; }
    ;;
  *)
    echo "用法： bash expose.sh [quick|named <域名>|ngrok]"
    exit 1
    ;;
esac
