from flask import Flask, Response
import time

app = Flask(__name__)

def generate_mp3_stream(file_path):
    """生成器：分块读取文件，模拟实时流"""
    chunk_size = 4096
    # 根据比特率估算每块数据的播放时长
    # 假设 128kbps = 16 KB/s，那么 4096 字节 ≈ 0.25 秒
    sleep_time = 0.25
    with open(file_path, "rb") as f:
        while chunk := f.read(chunk_size):
            yield chunk
            time.sleep(sleep_time)  # 控制发送速率，防止客户端瞬间缓冲太多

@app.route("/stream")
def stream():
    return Response(
        generate_mp3_stream("music.mp3"),
        mimetype="audio/mpeg"
    )

if __name__ == "__main__":
    # 监听所有网络接口，让局域网内其他设备能访问
    app.run(host="0.0.0.0", port=8000, threaded=True)