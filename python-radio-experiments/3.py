# controller.py
from flask import Flask, request, jsonify
import json

app = Flask(__name__)

# 假设播放状态保存在文件或 Redis 中
STATE_FILE = "state.json"

@app.route("/api/next", methods=["POST"])
def next_song():
    # 写入一个标志，让推流进程读到后切歌
    with open(STATE_FILE, "w") as f:
        json.dump({"action": "next"}, f)
    return jsonify({"status": "ok"})

@app.route("/api/status")
def status():
    return jsonify({"current_song": "...", "listeners": 0})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)