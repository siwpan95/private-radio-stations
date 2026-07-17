"""电台全局配置 —— 改这里就能定制你的电台。"""
import os

# 项目根目录（run.py 所在目录）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 媒体目录：把本地歌曲丢进这里
MUSIC_DIR = os.path.join(BASE_DIR, "music")

# 流媒体服务监听
HOST = "0.0.0.0"          # 0.0.0.0 = 监听所有网卡，局域网 / 公网均可访问
HTTP_PORT = 8000          # 控制面板 + 收听端口
STREAM_MOUNT = "/stream"  # 收听路径

# 电台元数据（会作为 ICY 头发送给播放器，VLC / Winamp 等会显示）
STATION_NAME = "我的Python电台"
STATION_NAME_ASCII = "My Python Radio"   # ICY 头只能含 ASCII，播放器里显示的台名
STATION_GENRE = "Various"
STATION_URL = ""

# 默认比特率（kbps）：当无法从文件嗅探到比特率时使用
DEFAULT_BITRATE = 128

# ICY 元数据间隔（字节）：每 8192 字节插入一次 “正在播放” 信息
ICY_METAINT = 8192

# 推流块大小（客户端不要元数据时）
CHUNK_SIZE = 4096

# 是否启用 “在线转播” 功能（需要 requests 库）
ENABLE_RELAY = True

# 直播源（麦克风）需要本机有 ffmpeg，默认关闭
ENABLE_MIC = False
MIC_BITRATE = 64
