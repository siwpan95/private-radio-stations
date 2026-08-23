"""流生成器：把远程电台转播（代理）成本地音频流。

- relay_stream：主 /stream 用的纯代理（requests），带多源 failover 重试。
- relay_mount：/stream/<bitrate> 用的 ffmpeg 实时转码（多码率挂载点）。

节奏控制：按默认比特率节流，避免一瞬间把远程流灌满。
"""
import subprocess
import time

from . import config


def ffmpeg_available():
    """ffmpeg 是否可用（决定 HLS / 多码率是否开启）。"""
    try:
        subprocess.run([config.FFMPEG, "-version"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                      timeout=10)
        return True
    except Exception:
        return False


def relay_stream(station):
    """转播当前 station.relay_url；主源连续失败自动 failover 到备用源。

    模式切回 idle 时干净退出（新连接会拿到 404/空流）。
    """
    import requests  # 仅转播时需要

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
            # 远程流断开：记一次失败，必要时切备用源；否则稍后重试
            switched = station.note_failure()
            if switched:
                continue
            time.sleep(2.0)


def relay_mount(station, bitrate):
    """多码率挂载点：ffmpeg 把当前转播源实时转成固定码率 MP3。

    每个连接起一个 ffmpeg 子进程（读 station.relay_url），输出 MP3 流给客户端。
    station 已不在转播时返回 None（调用方据此返回 409）。
    """
    with station.lock:
        if station.mode != "relay" or not station.relay_url:
            return None
        url = station.relay_url

    cmd = [
        config.FFMPEG, "-hide_banner", "-loglevel", "error",
        "-i", url,
        "-vn",                       # 不要视频
        "-acodec", "libmp3lame",
        "-b:a", f"{int(bitrate)}k",
        "-ar", "44100",
        "-f", "mp3",
        "-",                        # 输出到 stdout
    ]
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0,
        )
    except Exception:
        return None

    def gen():
        try:
            while True:
                chunk = proc.stdout.read(config.CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                proc.terminate()
            except Exception:
                pass

    return gen()
