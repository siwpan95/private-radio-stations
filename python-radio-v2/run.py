"""启动入口：优先用 waitress 提供多听众并发，否则退回 Flask 开发服务器。

用法：
    python run.py              # 只起本地服务
    python run.py --expose     # 起服务 + 自动 cloudflared quick tunnel（公网收听）
    python run.py --expose ngrok   # 同上但用 ngrok（failover 备选）

高级穿透（named tunnel 自定义域名 / 多隧道 failover / 守护重启）仍用：
    bash expose.sh [quick|named <域名>|ngrok]
"""
import os
import re
import sys
import time
import atexit
import shutil
import subprocess
import threading

# 让 radio 包可被导入
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from radio import config
from radio.web import app, station

_PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_URL_FILE = os.path.join(_PROJECT_DIR, "public_url.txt")
CF_DIR = "D:/cloudflared"


def _find_cloudflared():
    """定位 cloudflared 二进制：D:/cloudflared 硬路径优先，PATH 兜底。"""
    cand = os.path.join(CF_DIR, "cloudflared-windows-amd64.exe")
    if os.path.isfile(cand):
        return cand
    return shutil.which("cloudflared")


def _find_ngrok():
    """定位 ngrok 二进制。"""
    for cand in (os.path.join(CF_DIR, "ngrok-v3-stable-windows-amd64", "ngrok.exe"),
                 shutil.which("ngrok")):
        if cand and os.path.isfile(cand):
            return cand
    return None


def _write_public_url(url):
    """把公网地址写回 public_url.txt（面板轮询显示）。"""
    try:
        with open(PUBLIC_URL_FILE, "w", encoding="utf-8") as f:
            f.write((url or "") + "\n")
    except Exception:
        pass


def start_tunnel(port, mode="quick"):
    """启动穿透子进程，写回公网地址，注册 atexit 清理。
    mode: 'quick'(cloudflared trycloudflare) | 'ngrok'
    返回子进程 proc（失败返回 None）。"""
    if mode == "ngrok":
        bin_ = _find_ngrok()
        if not bin_:
            print("   [!] 未找到 ngrok，改用 cloudflared quick tunnel")
            return start_tunnel(port, "quick")
        log_file = os.path.join(_PROJECT_DIR, "ngrok.log")
        proc = subprocess.Popen(
            [bin_, "http", str(port), "--log=stdout"],
            stdout=open(log_file, "w"), stderr=subprocess.STDOUT,
        )
        # ngrok 通过本地 API 拿地址
        def _parse_ngrok():
            import json as _json
            for _ in range(30):
                time.sleep(1)
                try:
                    import urllib.request
                    r = urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2)
                    data = _json.loads(r.read())
                    for t in data.get("tunnels", []):
                        u = t.get("public_url", "")
                        if u.startswith("http"):
                            _write_public_url(u)
                            print(f"   🌐 公网地址：{u}/stream")
                            return
                except Exception:
                    pass
            print("   [!] 30s 内未拿到 ngrok 域名，看 ngrok.log")
        threading.Thread(target=_parse_ngrok, daemon=True).start()
    else:
        bin_ = _find_cloudflared()
        if not bin_:
            print("   [!] 未找到 cloudflared（D:/cloudflared/ 或 PATH），跳过穿透")
            print("       高级用法：bash expose.sh named <域名>  或  bash expose.sh ngrok")
            return None
        log_file = os.path.join(_PROJECT_DIR, "cloudflared.log")
        proc = subprocess.Popen(
            [bin_, "tunnel", "--url", f"http://localhost:{port}", "--no-autoupdate"],
            stdout=open(log_file, "w"), stderr=subprocess.STDOUT,
        )
        # cloudflared 从日志解析 trycloudflare 域名
        def _parse_cf():
            pat = re.compile(r"https://[a-z0-9.-]*\.trycloudflare\.com")
            for _ in range(30):
                time.sleep(1)
                try:
                    with open(log_file, encoding="utf-8", errors="replace") as f:
                        for line in f:
                            m = pat.search(line)
                            if m:
                                u = m.group(0)
                                _write_public_url(u)
                                print(f"   🌐 公网地址：{u}/stream  （面板自动显示）")
                                return
                except Exception:
                    pass
            print("   [!] 30s 内未拿到 trycloudflare 域名，看 cloudflared.log")
        threading.Thread(target=_parse_cf, daemon=True).start()

    # atexit 清理：服务退出时杀穿透子进程 + 删公网地址文件
    def _cleanup():
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except Exception:
                    proc.kill()
        except Exception:
            pass
        if os.path.exists(PUBLIC_URL_FILE):
            try:
                os.remove(PUBLIC_URL_FILE)
            except OSError:
                pass
    atexit.register(_cleanup)
    return proc


def main():
    # 解析 --expose 选项
    args = sys.argv[1:]
    expose = "--expose" in args
    expose_mode = "quick"
    if expose:
        i = args.index("--expose")
        if i + 1 < len(args) and args[i + 1] in ("quick", "ngrok"):
            expose_mode = args[i + 1]

    print(f"\n📻 {config.STATION_NAME} 启动中…（仅转播模式）")
    print(f"   控制面板 : http://localhost:{config.HTTP_PORT}/")
    print(f"   收听地址 : http://localhost:{config.HTTP_PORT}/stream")
    if expose:
        print(f"   穿透模式 : {expose_mode}（公网收听自动开启）")
    print("   按 Ctrl+C 停止\n")

    if expose:
        start_tunnel(config.HTTP_PORT, expose_mode)

    try:
        from waitress import serve
        serve(
            app,
            host=config.HOST,
            port=config.HTTP_PORT,
            threads=8,
            channel_timeout=60,
        )
    except ImportError:
        print("（未安装 waitress，使用 Flask 开发服务器；"
              "生产环境建议：pip install waitress）\n")
        app.run(host=config.HOST, port=config.HTTP_PORT, threaded=True)


if __name__ == "__main__":
    main()
