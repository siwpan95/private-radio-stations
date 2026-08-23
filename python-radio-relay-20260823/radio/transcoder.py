"""ffmpeg 转码基础设施：B 层（转码固定 MP3 / 多码率挂载点 / 开场 jingle / 录音）。

所有生成器都产出“干净 MP3”字节流，保证浏览器、VLC、Winamp、ESP32 都能播。
要求本机有 ffmpeg/ffprobe（项目已把它当外部依赖）。
"""
import os
import subprocess

from . import config


def ffmpeg_available():
    """ffmpeg 与 ffprobe 是否都可用。"""
    from shutil import which
    return bool(which(config.FFMPEG)) and bool(which(config.FFPROBE))


def http_open(url, timeout=12):
    """纯标准库打开 HTTP(S) URL（带浏览器 UA），返回可 .read() 的响应对象。

    用于转播直连等场景，替代 requests —— 新机器克隆仓库、只装了 Flask
    也能直接转播 MP3 源，零额外 pip 依赖。"""
    import urllib.request
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; MyPythonRadio/1.0)",
    })
    return urllib.request.urlopen(req, timeout=timeout)


def peek_http_headers(url, timeout=12):
    """打开 URL 探测响应头，返回 (resp, content_type)；失败返回 (None, None)。"""
    try:
        resp = http_open(url, timeout=timeout)
    except Exception:
        return None, None
    ctype = (resp.headers.get("Content-Type") or "").lower()
    return resp, ctype


def probe_remote_codec(url, timeout=15):
    """用 ffprobe 探测流/文件的音频编码名（'mp3'/'aac'/'vorbis'/...），失败返回 None。"""
    try:
        out = subprocess.run(
            [config.FFPROBE, "-v", "error",
             "-show_entries", "stream=codec_name",
             "-of", "default=nw=1:nk=1", url],
            capture_output=True, text=True, timeout=timeout,
        )
    except Exception:
        return None
    for line in out.stdout.splitlines():
        line = line.strip()
        if line:
            return line
    return None


def transcode(url, bitrate, low_latency=True):
    """生成器：把 url（远程 http(s) 或本地文件）转码为固定码率 MP3 并逐块产出。"""
    cmd = [config.FFMPEG, "-hide_banner", "-loglevel", "error"]
    if low_latency:
        cmd += ["-fflags", "nobuffer", "-flags", "low_delay", "-avioflags", "direct"]
    cmd += ["-i", url, "-vn", "-ac", "2", "-ar", "44100",
            "-acodec", "libmp3lame", "-b:a", f"{bitrate}k",
            "-f", "mp3", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            bufsize=config.CHUNK_SIZE)
    try:
        while True:
            chunk = proc.stdout.read(config.CHUNK_SIZE)
            if not chunk:
                break
            yield chunk
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()


def transcode_fade(url, bitrate, dur, fade=2.0):
    """E2：转码 + 开头淡入 + 末尾淡出（afade 滤镜）。
    dur=时长秒（None 则只淡入）；fade=淡入淡出秒数。供 broadcaster CROSSFADE 模式用。"""
    af = f"afade=in:0:d={fade}"
    if dur and dur > fade * 2:
        af += f",afade=out:st={dur - fade}:d={fade}"
    cmd = [config.FFMPEG, "-hide_banner", "-loglevel", "error",
           "-i", url, "-vn", "-af", af,
           "-ac", "2", "-ar", "44100",
           "-acodec", "libmp3lame", "-b:a", f"{bitrate}k",
           "-f", "mp3", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            bufsize=config.CHUNK_SIZE)
    try:
        while True:
            chunk = proc.stdout.read(config.CHUNK_SIZE)
            if not chunk:
                break
            yield chunk
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()


def jingle_prefix():
    """若配置了开场音且文件存在，产出其字节；否则空（等价无 jingle）。"""
    if config.ENABLE_JINGLE and os.path.exists(config.INTRO_JINGLE):
        with open(config.INTRO_JINGLE, "rb") as f:
            while True:
                b = f.read(config.CHUNK_SIZE)
                if not b:
                    break
                yield b


def record_tee(gen, path):
    """把 gen 产出的字节同时写入 path（边播边录），原样透传。"""
    with open(path, "wb") as f:
        for chunk in gen:
            f.write(chunk)
            yield chunk


def chain(*gens):
    """顺序拼接多个生成器。"""
    for g in gens:
        yield from g
