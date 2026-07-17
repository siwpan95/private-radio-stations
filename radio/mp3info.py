"""MP3 帧头解析：嗅探比特率，用于精确控制推流节奏（避免缓冲一会就断）。

只解析前 4 字节的帧头，纯 Python，无第三方依赖。
参考：MPEG Audio Frame Header 结构。
"""
import os

# MPEG1 Layer III 比特率表（kbps），下标 = 帧头中的 bitrate index
_MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
# MPEG2 / MPEG2.5 Layer III 比特率表
_MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]


def sniff_mp3_bitrate(path):
    """返回比特率(kbps)；不是 MP3 或解析失败返回 None。"""
    try:
        with open(path, "rb") as f:
            head = f.read(10)
    except OSError:
        return None
    if len(head) < 4:
        return None
    # 跳过开头可能存在的 ID3v2 标签（绝大多数 MP3 都有），否则第一字节是 'ID3' 不是帧同步字
    if head[:3] == b"ID3" and len(head) >= 10:
        size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
        try:
            with open(path, "rb") as f:
                f.seek(10 + size)
                head = f.read(4)
        except OSError:
            return None
    # 同步字：11 位全 1
    if len(head) < 4 or head[0] != 0xFF or (head[1] & 0xE0) != 0xE0:
        return None

    version = (head[1] >> 3) & 0x03   # 11=MPEG1, 10=MPEG2, 00=MPEG2.5
    layer = (head[1] >> 1) & 0x03     # 01=Layer III
    bitrate_index = (head[2] >> 4) & 0x0F

    if layer != 0x01:
        return None

    if version == 0x03:               # MPEG1
        bitrate = _MPEG1_L3_BITRATES[bitrate_index]
    elif version in (0x02, 0x00):     # MPEG2 / MPEG2.5
        bitrate = _MPEG2_L3_BITRATES[bitrate_index]
    else:
        return None

    return bitrate or None


# ---------------------------------------------------------------------------
# 格式感知探测：返回真实比特率 + 正确的 MIME，避免因 Content-Type 错/节奏错而无声
# ---------------------------------------------------------------------------
_CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


def _probe_flac(path):
    """FLAC：解析 STREAMINFO 块得到采样率/声道/位深 → 精确比特率(kbps)。"""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"fLaC":
                return None
            f.seek(18)              # STREAMINFO 内打包字段起始处
            w = f.read(8)
        if len(w) < 8:
            return None
        n = int.from_bytes(w, "big")
        sr = (n >> 44) & 0xFFFFF           # 20 bit 采样率
        ch = ((n >> 41) & 0x7) + 1         # 3 bit 声道数
        bps = ((n >> 36) & 0x1F) + 1       # 5 bit 位深
        if sr == 0 or ch == 0 or bps == 0:
            return None
        return sr * ch * bps // 1000       # FLAC 是无损 PCM，比特率可精确算出
    except OSError:
        return None


def _probe_wav(path):
    """WAV：找 fmt 块，byte rate 字段直接给出比特率。"""
    try:
        with open(path, "rb") as f:
            if f.read(12)[8:12] != b"WAVE":
                return None
            f.seek(12)
            while True:
                chunk = f.read(8)
                if len(chunk) < 8:
                    return None
                cid = chunk[:4]
                size = int.from_bytes(chunk[4:8], "little")
                if cid == b"fmt ":
                    fmt = f.read(16)
                    if len(fmt) < 16:
                        return None
                    sr = int.from_bytes(fmt[4:8], "little")
                    ch = int.from_bytes(fmt[10:12], "little")
                    bits = int.from_bytes(fmt[14:16], "little")
                    return sr * ch * bits // 1000
                f.seek(size + (size & 1), 1)    # 跳过，按偶数字节对齐
    except OSError:
        return None


def probe_audio(path):
    """返回 {'bitrate': kbps 或 None, 'ctype': MIME}。

    bitrate 为 None 表示无法纯 Python 估算（如 ogg），调用方应“灌流”（不节流），
    否则播放器缓冲会被抽干导致无声。
    """
    ext = os.path.splitext(path)[1].lower()
    ctype = _CONTENT_TYPES.get(ext, "audio/mpeg")
    if ext == ".mp3":
        br = sniff_mp3_bitrate(path)
    elif ext == ".flac":
        br = _probe_flac(path)
    elif ext == ".wav":
        br = _probe_wav(path)
    else:
        br = None            # ogg 等：无法估算 → 灌流
    return {"bitrate": br, "ctype": ctype}
