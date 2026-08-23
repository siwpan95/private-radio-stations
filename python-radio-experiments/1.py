import shout
import time
import os
import glob

# Icecast 配置
ICECAST_HOST = "127.0.0.1"
ICECAST_PORT = 8000
ICECAST_MOUNT = "/stream"         # 挂载点，客户端收听路径
ICECAST_PASSWORD = "hackme"       # source 密码
ICECAST_FORMAT = "mp3"            # 推流格式

# 初始化 Shout 实例
s = shout.Shout()
s.host = ICECAST_HOST
s.port = ICECAST_PORT
s.mount = ICECAST_MOUNT
s.password = ICECAST_PASSWORD
s.format = ICECAST_FORMAT
s.protocol = shout.PROTOCOL_HTTP   # 或 PROTOCOL_ICY（Shoutcast 兼容）
s.audio_info = {
    shout.SHOUT_AI_BITRATE: "128",
    shout.SHOUT_AI_SAMPLERATE: "44100",
    shout.SHOUT_AI_CHANNELS: "2"
}

# 打开连接
s.open()

# 读取 MP3 文件并推流
def stream_mp3(filepath, title="Unknown"):
    # 设置元数据（歌曲名）
    metadata = {"song": title}
    s.metadata = metadata

    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(4096)
            if not chunk:
                break
            s.send(chunk)
            s.sync()

# 播放列表：收集当前目录下所有 mp3
playlist = glob.glob("music/*.mp3")

try:
    while True:
        for song in playlist:
            title = os.path.basename(song).replace(".mp3", "")
            print(f"正在播放：{title}")
            stream_mp3(song, title)
except KeyboardInterrupt:
    s.close()