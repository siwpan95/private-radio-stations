"""Flask 控制面板 + 流媒体路由（转播-only 版）。

- GET  /                    控制面板（网页，自带在线收听）
- GET  /stream              主音频流（代理当前转播源；空闲返回 409）
- GET  /stream/<k>          多码率挂载点（k ∈ TRANSCODE_MOUNTS，ffmpeg 实时转码）
- GET  /hls/<file>          HLS 分片（live.m3u8 / *.ts）
- GET  /api/status          JSON 状态
- POST /api/relay           开始转播 {"url","name?","fallbacks?":[...]}
- POST /api/relay/stop     停止转播
- GET  /api/browse          搜索 Radio-Browser.info 全球电台 ?q=
- POST /api/presets         把电台写入 presets.json（去重 + 原子写）
- GET  /api/public-url      expose 写回的公网地址
"""
import json
import os

from flask import (
    Flask, Response, request, jsonify, render_template, send_from_directory,
)

from . import config
from .station import RadioStation
from .streamer import relay_stream, relay_mount, ffmpeg_available
from .hls import hls_manager

station = RadioStation()
app = Flask(__name__)

_PRESETS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "presets.json"
)
_PUBLIC_URL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public_url.txt"
)


def load_presets():
    """读取 presets.json（每项 {name,url,desc?,icon?}），改完刷新页面即生效。"""
    try:
        with open(_PRESETS_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [p for p in data if isinstance(p, dict) and p.get("url")]


def read_public_url():
    try:
        with open(_PUBLIC_URL_PATH, encoding="utf-8") as f:
            u = f.read().strip()
        return u or None
    except Exception:
        return None


def _make_stream_response(gen):
    """包装音频流生成器，附带 ICY 头与听众计数。"""
    headers = {
        "Content-Type": "audio/mpeg",
        "icy-name": config.STATION_NAME_ASCII,
        "icy-genre": station.genre,
        "icy-br": str(config.DEFAULT_BITRATE),
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",
    }
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
        hls_enabled=hls_manager.enabled(),
        mounts=list(config.TRANSCODE_MOUNTS) if ffmpeg_available() else [],
    )


@app.route("/stream")
def stream():
    if station.mode != "relay":
        return jsonify({"ok": False, "error": "当前未转播，请先开始转播"}), 409
    return _make_stream_response(relay_stream(station))


@app.route("/stream/<int:k>")
def stream_mount(k):
    if k not in config.TRANSCODE_MOUNTS or not ffmpeg_available():
        return jsonify({"ok": False, "error": "该码率未启用或 ffmpeg 不可用"}), 404
    gen = relay_mount(station, k)
    if gen is None:
        return jsonify({"ok": False, "error": "当前未转播"}), 409
    return _make_stream_response(gen)


@app.route("/hls/<path:filename>")
def hls_file(filename):
    if not hls_manager.enabled():
        return jsonify({"ok": False, "error": "HLS 未启用（需要 ffmpeg）"}), 404
    # HLS 只在转播进行时有意义；空闲时旧的/空的 m3u8 不应被服务
    if station.mode != "relay":
        return jsonify({"ok": False, "error": "当前未转播，无 HLS"}), 404
    # 防目录穿越
    if ".." in filename or filename.startswith("/"):
        return jsonify({"ok": False, "error": "bad path"}), 400
    try:
        full = os.path.join(config.HLS_DIR, filename)
        if not os.path.isfile(full):
            return jsonify({"ok": False, "error": "not found"}), 404
        if filename.endswith(".m3u8"):
            ctype = "application/vnd.apple.mpegurl"
        elif filename.endswith(".ts"):
            ctype = "video/mp2t"
        else:
            ctype = "application/octet-stream"
        resp = send_from_directory(config.HLS_DIR, filename, mimetype=ctype)
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    except Exception:
        return jsonify({"ok": False, "error": "not found"}), 404


@app.route("/api/status")
def api_status():
    return jsonify(station.status())


@app.route("/api/relay", methods=["POST"])
def api_relay():
    if request.is_json:
        body = request.json or {}
        url = body.get("url")
        name = body.get("name")
        fallbacks = body.get("fallbacks") or body.get("fallback")
    else:
        url = request.form.get("url")
        name = request.form.get("name")
        fallbacks = None
    if isinstance(fallbacks, str):
        fallbacks = [u.strip() for u in fallbacks.split(",") if u.strip()]
    if not url:
        return jsonify({"ok": False, "error": "缺少 url"}), 400

    station.set_relay(url, name, fallbacks)
    hls_manager.start(url)   # HLS 随转播启动（ffmpeg 不可用时静默跳过）
    return jsonify({"ok": True, "url": url, "name": name,
                    "hls": hls_manager.enabled()})


@app.route("/api/relay/stop", methods=["POST"])
def api_relay_stop():
    station.stop_relay()
    hls_manager.stop()
    return jsonify({"ok": True})


@app.route("/api/browse")
def api_browse():
    """搜索 Radio-Browser.info 全球电台目录。"""
    from .directory import search as rb_search
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"ok": True, "stations": []})
    stations = rb_search(q)
    return jsonify({"ok": True, "stations": stations})


@app.route("/api/public-url")
def api_public_url():
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
        if any((p.get("url") or "").strip() == url for p in data if isinstance(p, dict)):
            return jsonify({"ok": True, "dup": True, "count": len(data)})
        entry = {"name": name, "url": url}
        if desc:
            entry["desc"] = desc
        if icon:
            entry["icon"] = icon
        data.append(entry)
        tmp = _PRESETS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _PRESETS_PATH)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "count": len(data)})
