"""启动入口：优先用 waitress 提供多听众并发，否则退回 Flask 开发服务器。

用法：
    python run.py
"""
import os
import sys

# 让 radio 包可被导入
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from radio import config
from radio.web import app, station


def main():
    print(f"\n📻 {config.STATION_NAME} 启动中…")
    print(f"   控制面板 : http://localhost:{config.HTTP_PORT}/")
    print(f"   收听地址 : http://localhost:{config.HTTP_PORT}/stream")
    print(f"   歌曲目录 : {config.MUSIC_DIR}  （{station.status()['playlist_size']} 首）")
    print("   按 Ctrl+C 停止\n")

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
