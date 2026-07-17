"""Flask 控制面板 + 流媒体路由。

- GET  /               控制面板（网页，自带在线收听）
- GET  /stream         音频流（支持 ICY 元数据）
- GET  /api/status     JSON 状态
- POST /api/next       下一首
- POST /api/pause      暂停 / 继续
- POST /api/shuffle    随机播放开关
- POST /api/rescan     重新扫描歌单
- POST /api/relay      开始转播某个网络电台 URL
- POST /api/relay/stop 停止转播
"""
import json
import os

from flask import Flask, Response, request, jsonify, render_template

from . import config
from .station import RadioStation
from .streamer import playlist_stream, relay_stream
from .mp3info import probe_audio
from .directory import search as rb_search

station = RadioStation()
app = Flask(__name__)

_PRESETS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "presets.json"
)

def load_presets():
    """读取 presets.json 里的精选电台预设（每项 {name,url,desc?,icon?}）。
    文件缺失或格式错误时返回 []，不阻断主程序。每次请求都读，改完刷新页面即生效。"""
    try:
        with open(_PRESETS_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [p for p in data if isinstance(p, dict) and p.get("url")]


_PUBLIC_URL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public_url.txt"
)

def read_public_url():
    """读取 expose.sh 写回的公网穿透地址（文件不存在/为空返回 None）。"""
    try:
        with open(_PUBLIC_URL_PATH, encoding="utf-8") as f:
            u = f.read().strip()
        return u or None
    except Exception:
        return None


def _make_stream_response(gen, metaint):
    # Content-Type 必须和真实格式一致，否则浏览器/播放器解码失败 → 没声音
    ctype = "audio/mpeg"
    if station.mode != "relay":
        p = station.current_path()
        if p:
            ctype = probe_audio(p)["ctype"]

    headers = {
        "Content-Type": ctype,
        "icy-name": config.STATION_NAME_ASCII,   # HTTP 头必须 ASCII
        "icy-genre": station.genre,
        "icy-br": str(config.DEFAULT_BITRATE),
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",   # 关掉反代缓冲，保证实时
    }
    if metaint > 0:
        headers["icy-metaint"] = str(metaint)

    station.add_listener()

    def wrapped():
        try:
            yield from gen
        finally:
            station.remove_listener()

    return Response(wrapped(), headers=headers)


@app.route("/")
def index():
    return render_template(
        "index.html",
        station=station.station_name,
        genre=station.genre,
        presets=load_presets(),
        public_url=read_public_url(),
    )


@app.route("/stream")
def stream():
    # 客户端声明支持 ICY 元数据，且当前是歌单模式，才插入元数据
    wants_meta = request.headers.get("Icy-MetaData", "").strip() == "1"
    metaint = config.ICY_METAINT if (wants_meta and station.mode == "playlist") else 0

    if station.mode == "relay":
        return _make_stream_response(relay_stream(station, 0), 0)
    return _make_stream_response(playlist_stream(station, metaint), metaint)


@app.route("/api/status")
def api_status():
    return jsonify(station.status())


@app.route("/api/next", methods=["POST"])
def api_next():
    station.next()
    return jsonify({"ok": True})


@app.route("/api/pause", methods=["POST"])
def api_pause():
    paused = station.toggle_pause()
    return jsonify({"ok": True, "paused": paused})


@app.route("/api/shuffle", methods=["POST"])
def api_shuffle():
    sh = station.toggle_shuffle()
    return jsonify({"ok": True, "shuffle": sh})


@app.route("/api/rescan", methods=["POST"])
def api_rescan():
    n = station.rescan()
    return jsonify({"ok": True, "count": n})


@app.route("/api/relay", methods=["POST"])
def api_relay():
    if request.is_json:
        body = request.json or {}
        url = body.get("url")
        name = body.get("name")
    else:
        url = request.form.get("url")
        name = request.form.get("name")
    if not url:
        return jsonify({"ok": False, "error": "缺少 url"}), 400
    station.set_relay(url, name)
    return jsonify({"ok": True, "url": url})


@app.route("/api/browse")
def api_browse():
    """搜索 Radio-Browser.info 全球电台目录。"""
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"ok": True, "stations": []})
    stations = rb_search(q)
    return jsonify({"ok": True, "stations": stations})


@app.route("/api/public-url")
def api_public_url():
    """返回 expose.sh 写回的公网穿透地址（没有则返回 {"url": null}）。"""
    return jsonify({"url": read_public_url()})


@app.route("/api/presets", methods=["POST"])
def api_add_preset():
    """把当前转播 / 浏览到的电台写入 presets.json（去重 + 原子写）。"""
    if request.is_json:
        body = request.json or {}
    else:
        body = request.form or {}
    url = (body.get("url") or "").strip()
    name = (body.get("name") or "").strip() or url
    desc = (body.get("desc") or "").strip()
    icon = (body.get("icon") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "缺少 url"}), 400
    try:
        try:
            with open(_PRESETS_PATH, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = []
        if not isinstance(data, list):
            data = []
        # 按 url 去重
        if any((p.get("url") or "").strip() == url for p in data if isinstance(p, dict)):
            return jsonify({"ok": True, "dup": True, "count": len(data)})
        entry = {"name": name, "url": url}
        if desc:
            entry["desc"] = desc
        if icon:
            entry["icon"] = icon
        data.append(entry)
        # 原子写：先写临时文件再替换，避免写到一半崩溃损坏
        tmp = _PRESETS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _PRESETS_PATH)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "count": len(data)})


@app.route("/api/relay/stop", methods=["POST"])
def api_relay_stop():
    station.stop_relay()
    return jsonify({"ok": True})
