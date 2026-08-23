"""电台全局配置 —— 改这里就能定制你的电台。"""
import os

# 项目根目录（run.py 所在目录）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 媒体目录：把本地歌曲丢进这里
MUSIC_DIR = os.path.join(BASE_DIR, "music")

# ---------- 公网穿透 ----------
# ngrok 静态域名：免费版可在 dashboard（https://dashboard.ngrok.com/domains）
# 领取 1 个固定域名（形如 xxx.ngrok-free.app / xxx.ngrok-free.dev）。
# 设置后 --expose ngrok 固定使用该域名，公网地址不再每次随机；留空 = 每次启动随机域名。
# 建议用环境变量设置（个人域名不入版本库）：
#     setx NGROK_STATIC_DOMAIN "你的域名.ngrok-free.dev"
# 也可以直接改这里（本文件会随仓库同步，域名是公开信息，无泄密风险）。
NGROK_STATIC_DOMAIN = os.environ.get("NGROK_STATIC_DOMAIN", "").strip()

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

# ---------- B 层：ffmpeg 转码 ----------
# 二进制自带策略（与 cloudflared/ 一致）：优先用项目内 ffmpeg/ 目录里的可执行文件，
# 找不到才回退 PATH。避免依赖机器上可能过旧的全局 ffmpeg（旧版无 -hls_flags，HLS 会直接失败）。
FFMPEG_DIR = os.path.join(BASE_DIR, "ffmpeg")


def _bundled_bin(name):
    """返回项目自带二进制的绝对路径；不存在则回退为裸名字（走 PATH）。"""
    for fn in (name + ".exe", name):
        p = os.path.join(FFMPEG_DIR, fn)
        if os.path.isfile(p):
            return p
    return name


FFMPEG = _bundled_bin("ffmpeg")
FFPROBE = _bundled_bin("ffprobe")

TRANSCODE_RELAY = True        # 转播非 MP3 流（AAC/OGG 等）时自动转码成固定 MP3
TRANSCODE_BITRATE = 128       # 转码目标码率（kbps）—— 同时解决“老客户端/ESP32 无声”
TRANSCODE_MOUNTS = (64, 320)  # 多码率挂载点（额外 /stream/<bitrate>：手机省流量 / WiFi 高音质）

# ---------- D1：HLS 直播切片 ----------
HLS_SEGMENT_SEC = 2      # 切片时长（秒）：越小延迟越低但请求越碎，2s 是低延迟与开销的平衡点
HLS_LIST_SIZE = 8        # playlist 保留片数（8×2s≈16s 窗口，够播放器抗网络抖动）
HLS_DELETE_THRESHOLD = 4  # 出列后再多留几片才删：公网/CDN 有延迟，删太快客户端会 404
# 音频 ABR 码率阶梯（kbps）。**第一档是播放器的起播档位**，之后按实测带宽自动升降。
# 写成单元素 (128,) 即退化为单码率。只用 AAC-LC，勿换 HE-AAC（Safari/iOS 兼容性最好）。
HLS_VARIANTS = (128, 64)

CROSSFADE = False             # E2：歌单切歌时淡入淡出（afade 滤镜，开启则每首经 ffmpeg 转码，CPU 略增）
CROSSFADE_SEC = 2.0           # E2：淡入淡出秒数

ENABLE_JINGLE = True          # 新听众连入时先放一段台标音（Icecast intro 思路）
INTRO_JINGLE = os.path.join(BASE_DIR, "jingle.mp3")  # 文件不存在则自动跳过

RECORD_DIR = os.path.join(BASE_DIR, "recordings")
RECORD_MAX_SECONDS = 0        # 录音安全上限（秒）；0 = 不限，手动停止

# ---------- F 层：musickit 随机渲染源（代替本地 music/ 歌单）----------
# 电台默认音源：'musickit' = musickit 随机渲染（每曲随机混音师签名 +
# 随机流派提示词 + 随机 stems）；'playlist' = 传统本地歌单（music/ 目录）。
DEFAULT_SOURCE = "musickit"

# musickit 仓库根目录：合并后电台位于 <musickit>/radio/，默认取 BASE_DIR 的上级；
# 环境变量 MUSICKIT_ROOT 可覆盖（换目录/分离部署时用）。
MUSICKIT_ROOT = os.environ.get("MUSICKIT_ROOT") or os.path.dirname(BASE_DIR)

# 渲染输出缓存目录（渲染好的 MP3 先落盘再推流，保留最近几首便于转码挂载点回放）
MUSICKIT_RENDER_CACHE = os.path.join(BASE_DIR, "render_cache")

# 渲染参数（与 remix/tools/mixer_radio.py 一致）：
MUSICKIT_RENDER_CHANNEL = "random"   # 混音师频道 slug；random = 每曲随机一位
MUSICKIT_RENDER_BARS = 32            # 每曲小节数（32 小节 ≈ 100 秒左右）
MUSICKIT_RENDER_FMT = "mp3"
MUSICKIT_RENDER_MAX_TRACKS = 5       # 单曲最大音轨数
MUSICKIT_RENDER_FUSION = True        # 提示词跨类融合（增加新鲜感）
MUSICKIT_RENDER_RELEASE_SAFE = False # 仅用 free/pack 授权素材（发布安全）
MUSICKIT_RENDER_TIMEOUT = 600        # 单曲渲染超时（秒）
MUSICKIT_RENDER_QUEUE_DEPTH = 3      # 预渲染就绪队列深度
MUSICKIT_RENDER_KEEP = 20            # 缓存目录最多保留的渲染文件数
# 渲染子进程解释器：默认当前解释器（需 pydub/numpy/scipy/soundfile/audioop-lts）
MUSICKIT_RENDER_PYTHON = ""          # 留空 = sys.executable；可填 F:\Python314\python.exe 等
