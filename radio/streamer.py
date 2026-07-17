"""流生成器：把歌单变成持续不断的音频流。

- playlist_stream：本地歌单流，支持 ICY 元数据（让播放器显示 “正在播放”）。
- relay_stream：转播另一个网络电台（代理其 HTTP 音频流）。

节奏控制：根据文件比特率（MP3 帧头嗅探）计算每秒应发送的字节数，
让客户端平滑缓冲，而不是一瞬间灌满。
"""
import time

from . import config
from .mp3info import probe_audio
from .station import _display_title


def _metadata_block(title, changed):
    """构造 ICY 元数据块。

    changed=False 时发送空块（仅 1 字节 0x00），节省带宽；
    changed=True 时发送 'StreamTitle=...;'，长度按 16 字节对齐。
    """
    if not changed:
        return b"\x00"
    meta = f"StreamTitle='{title}';".encode("utf-8", "replace")
    length = (len(meta) + 15) // 16
    padded = meta + b"\x00" * (length * 16 - len(meta))
    return bytes([length]) + padded


def playlist_stream(station, metaint=0):
    """生成歌单音频流。metaint>0 时插入 ICY 元数据。"""
    last_title = None
    try:
        while True:
            # 模式切换：进入转播后让出（新连接会走 relay_stream）
            with station.lock:
                if station.mode != "playlist":
                    time.sleep(0.2)
                    continue
                if station.paused:
                    while station.paused:
                        time.sleep(0.2)
                path = station.current_path()

            if not path:
                time.sleep(1.0)
                continue

            station.set_title(_display_title(path))

            # 按格式解析真实比特率：FLAC/WAV 精确、MP3 嗅探；
            # 无法估算（如 ogg）则 flood=True 不节流，避免播放器饿死无声
            probe = probe_audio(path)
            flood = probe["bitrate"] is None
            bytes_per_sec = 0.0 if flood else max(1.0, probe["bitrate"] * 1000 / 8)

            chunk = metaint if metaint > 0 else config.CHUNK_SIZE

            try:
                f = open(path, "rb")
            except OSError:
                station._advance()
                continue

            with f:
                while True:
                    if station.next_event.is_set():
                        station._advance()
                        break
                    if station.paused:
                        while station.paused:
                            time.sleep(0.2)

                    data = f.read(chunk)
                    if not data:
                        break

                    yield data

                    if metaint > 0:
                        changed = (station.current_title != last_title)
                        last_title = station.current_title
                        yield _metadata_block(station.current_title, changed)

                    # 按比特率节奏发送（flood 时不睡，直接灌，保证有声）
                    if bytes_per_sec > 0:
                        time.sleep(len(data) / bytes_per_sec)

                station._advance()   # 一首播完，前进
    except GeneratorExit:
        # 客户端断开，干净退出
        pass


def relay_stream(station, metaint=0):
    """转播远程电台：代理其音频流。"""
    import requests  # 仅转播时需要

    # 转播模式下不插入本地 ICY 元数据（远程流自带结构）
    while True:
        with station.lock:
            if station.mode != "relay":
                break
            url = station.relay_url
        if not url:
            time.sleep(1.0)
            continue

        bytes_per_sec = config.DEFAULT_BITRATE * 1000 / 8
        try:
            r = requests.get(url, stream=True, timeout=10)
            for chunk in r.iter_content(chunk_size=config.CHUNK_SIZE):
                if station.mode != "relay":
                    break
                if not chunk:
                    continue
                yield chunk
                time.sleep(len(chunk) / bytes_per_sec)
        except Exception:
            # 远程流断开，稍后重试
            time.sleep(2.0)
