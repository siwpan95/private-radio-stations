from flask import Flask, Response, request, jsonify
import threading

app = Flask(__name__)
next_song_event = threading.Event()

@app.route("/stream")
def stream():
    def gen():
        while True:
            for song in songs:
                with open(song, "rb") as f:
                    while chunk := f.read(4096):
                        yield chunk
                        # 检查是否需要切歌
                        if next_song_event.is_set():
                            next_song_event.clear()
                            break
                    if next_song_event.is_set():
                        break
    return Response(gen(), mimetype="audio/mpeg")

@app.route("/api/next")
def next_song():
    next_song_event.set()
    return jsonify({"status": "ok"})