import glob
from flask import Flask, Response
import time

app = Flask(__name__)
MUSIC_FOLDER = "./music"

def generate_playlist_stream():
    """不断循环文件夹内的 MP3 文件"""
    songs = glob.glob(f"{MUSIC_FOLDER}/*.mp3")
    if not songs:
        yield b""  # 无歌可播
        return

    chunk_size = 4096
    sleep_time = 0.25
    while True:                     # 外层死循环：循环整个歌单
        for song in songs:
            print(f"正在播放：{song}")
            with open(song, "rb") as f:
                while chunk := f.read(chunk_size):
                    yield chunk
                    time.sleep(sleep_time)
            # 一首歌播完，短暂静音间隙（可选）
            time.sleep(0.5)

@app.route("/stream")
def stream():
    return Response(
        generate_playlist_stream(),
        mimetype="audio/mpeg"
    )