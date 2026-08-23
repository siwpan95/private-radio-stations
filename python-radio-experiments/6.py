import subprocess
from flask import Flask, Response

app = Flask(__name__)

def generate_live_stream():
    # 使用 ffmpeg 捕获默认麦克风，转码为 MP3 输出到管道
    cmd = [
        "ffmpeg",
        "-f", "avfoundation" if sys.platform == "darwin" else "dshow",
        "-i", ":0",                     # 根据系统调整设备名
        "-acodec", "libmp3lame",
        "-ab", "64k",
        "-f", "mp3",
        "pipe:1"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while True:
            chunk = proc.stdout.read(4096)
            if not chunk:
                break
            yield chunk
    finally:
        proc.terminate()

@app.route("/live")
def live():
    return Response(generate_live_stream(), mimetype="audio/mpeg")