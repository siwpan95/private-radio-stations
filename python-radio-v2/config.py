"""电台全局配置 —— 改这里就能定制你的转播电台。

本版本只做一件事：把任意网络电台（预设 / 手动输入 / 浏览发现）转播出去。
本地歌单、录音、歌词、社群同步等全部移除。
"""
import os

# 项目根目录（run.py 所在目录）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 流媒体服务监听
HOST = "0.0.0.0"          # 0.0.0.0 = 监听所有网卡，局域网 / 公网均可访问
HTTP_PORT = 8000          # 控制面板 + 收听端口
STREAM_MOUNT = "/stream"  # 主收听路径

# 电台元数据（会作为 ICY 头发送给播放器，VLC / Winamp 等会显示）
STATION_NAME = "我的Python电台"
STATION_NAME_ASCII = "My Python Radio"   # ICY 头只能含 ASCII，播放器里显示的台名
STATION_GENRE = "Relay"                  # 本版只做转播
STATION_URL = ""

# 默认比特率（kbps）：转播流节奏控制 / HLS·多码率兜底
DEFAULT_BITRATE = 128

# 推流块大小（客户端不要元数据时）
CHUNK_SIZE = 4096

# 是否启用 “在线转播” 功能（需要 requests 库，纯代理无需 ffmpeg）
ENABLE_RELAY = True

# ---------- ffmpeg（HLS 切片 + 多码率转码需要）----------
# 二进制自带策略：优先用项目内 ffmpeg/ 目录，找不到才回退 PATH。
# ffmpeg/ 已加入 .gitignore，请自行放入 ffmpeg.exe（或从 https://www.gyan.dev/ffmpeg/ 下载）。
FFMPEG_DIR = os.path.join(BASE_DIR, "ffmpeg")


def _bundled_bin(name):
    """返回项目自带二进制的绝对路径；不存在则回退为裸名字（走 PATH）。"""
    for fn in (name + ".exe", name):
        p = os.path.join(FFMPEG_DIR, fn)
        if os.path.isfile(p):
            return p
    return name


FFMPEG = _bundled_bin("ffmpeg")

# ---------- HLS 直播切片（D 层）----------
# 把当前转播流切成分片，供网页 <audio>/<video> 低延迟播放，路径 /hls/live.m3u8。
HLS_DIR = os.path.join(BASE_DIR, "hls")
HLS_SEGMENT_SEC = 4          # 切片时长（秒）：越小延迟越低但请求越碎
HLS_LIST_SIZE = 6            # playlist 保留片数（窗口 ≈ 6×4s ≈ 24s）
HLS_DELETE_THRESHOLD = 3     # 出列后再多留几片才删，避免客户端刚取到就 404

# ---------- 多码率挂载点（B 层）----------
# 额外 /stream/<bitrate>：手机省流量 / WiFi 高音质（ffmpeg 实时转码）。
# 写成空元组 () 即关闭多码率，只保留主 /stream。
TRANSCODE_MOUNTS = (64, 320)
