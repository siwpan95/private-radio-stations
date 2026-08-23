"""Flask 控制面板 + 流媒体路由。

路由总览：
  GET  /                    控制面板（网页，自带在线收听）
  GET  /login               登录页
  POST /login               登录
  GET  /logout              登出
  GET  /files               文件管理页
  GET  /api/docs            API 文档（Swagger UI）
  GET  /api/openapi.json    OpenAPI 3.0 规范
  GET  /stream              音频流（支持 ICY 元数据）
  GET  /api/status          JSON 状态
  POST /api/skip            下一首 [需登录]
  POST /api/play            继续播放 [需登录]
  POST /api/shuffle         随机播放开关 [需登录]
  POST /api/rescan          重新扫描歌单 [需登录]
  POST /api/relay           开始转播某个网络电台 URL [需登录]
  POST /api/relay/stop      停止转播 [需登录]
  POST /api/musickit        musickit 随机渲染源 开始/停止/参数 [需登录]
  GET  /api/upload/progress/<task_id>  上传进度
  POST /api/upload          上传音乐文件 [需登录]
  GET  /api/files           列出音乐文件 [需登录]
  DELETE /api/files/<name>  删除音乐文件 [需登录]
  GET  /api/presets         电台预设列表
  POST /api/presets/switch  切换电台预设 [需登录]
"""
import json
import os
import time
from urllib.parse import quote

from flask import Flask, Response, request, jsonify, render_template, send_file, session, redirect, url_for

from . import config
from .station import RadioStation
from .streamer import playlist_stream, relay_stream, mount_stream
from .mp3info import probe_audio
from .directory import search as rb_search
from . import transcoder
from . import metadata
from . import lyrics
from . import integrations
from . import hls
from . import broadcaster as _bc_module
from . import schedule
from . import stats
from . import auth
from . import uploads
from . import presets
from . import api_docs

station = RadioStation()
app = Flask(__name__)

# ── 认证初始化 ──
auth.init_auth(app)
auth.register_routes(app)

# ── 上传模块注册 ──
uploads.register_routes(app)

# ── 电台预设模块注册 ──
presets.register_routes(app)

# ── API 文档模块注册 ──
app.register_blueprint(api_docs.docs_bp)

# D2：全局广播生产者（单线程读源 → 多听众 queue 订阅，磁盘 IO 不随听众数增长）
_broadcaster = _bc_module.Broadcaster(station)
try:
    _broadcaster.start()
except Exception:
    pass

# D1：启动 HLS 切片后台线程（没装 ffmpeg 会安全跳过，不影响主服务）
try:
    hls.start()
except Exception:
    pass

# E1：启动节目单定时线程
try:
    schedule.start(station)
except Exception:
    pass

# E4：听众统计 SQLite 初始化
try:
    stats.init()
except Exception:
    pass

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

_PWA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pwa")

def read_public_url():
    """读取 expose.sh 写回的公网穿透地址（文件不存在/为空返回 None）。"""
    try:
        with open(_PUBLIC_URL_PATH, encoding="utf-8") as f:
            u = f.read().strip()
        return u or None
    except Exception:
        return None


def _make_stream_response(gen, metaint, force_mp3=False, br=None):
    # Content-Type 必须和真实格式一致，否则浏览器/播放器解码失败 → 没声音
    ctype = "audio/mpeg"
    if not force_mp3 and station.mode != "relay":
        p = station.current_path()
        if p:
            ctype = probe_audio(p)["ctype"]

    headers = {
        "Content-Type": ctype,
        "icy-name": config.STATION_NAME_ASCII,   # HTTP 头必须 ASCII
        "icy-genre": station.genre,
        "icy-br": str(br if br else config.DEFAULT_BITRATE),
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",   # 关掉反代缓冲，保证实时
    }
    if metaint > 0:
        headers["icy-metaint"] = str(metaint)

    # D4 听众连接日志：记录 IP/UA，断开时算时长
    ip = request.remote_addr or ""
    ua = request.headers.get("User-Agent", "")
    lid = station.add_listener(ip, ua)

    def wrapped():
        try:
            yield from gen
        finally:
            station.remove_listener(lid)

    return Response(wrapped(), headers=headers)


@app.route("/")
def index():
    # 如果已配置密码但未登录 → 跳转登录页
    if auth.is_configured() and not session.get("logged_in"):
        return redirect(url_for("login"))
    return render_template(
        "index.html",
        station=station.station_name,
        genre=station.genre,
        presets=load_presets(),
        public_url=read_public_url(),
        logged_in=session.get("logged_in", False),
    )


@app.route("/stream")
def stream():
    # 客户端声明支持 ICY 元数据，且当前是歌单模式（且未录音），才插入元数据
    wants_meta = request.headers.get("Icy-MetaData", "").strip() == "1"
    recording = station.recording

    if station.mode == "relay":
        # 转播路径始终输出 MP3（转码或已是 mp3），force_mp3 保证 Content-Type 正确
        # D2：订阅广播者（relay 录音由广播者 tee）
        return _make_stream_response(relay_stream(station, 0, _broadcaster), 0, force_mp3=True)

    # 歌单模式
    if recording:
        # 录音时强制转码成固定 MP3，保证录制文件干净（不再带 ICY 元数据）
        # 录音走 per-listener mount_stream（转码 + tee），不共享广播者
        gen = mount_stream(station, config.TRANSCODE_BITRATE, record_path=station.recording_path)
        return _make_stream_response(gen, 0, force_mp3=True, br=config.TRANSCODE_BITRATE)

    metaint = config.ICY_METAINT if wants_meta else 0
    # D2：订阅广播者（共享广播缓冲，N 听众 = 1 次磁盘读）
    return _make_stream_response(playlist_stream(station, metaint, _broadcaster), metaint)


@app.route("/stream/<int:bitrate>")
def stream_mount(bitrate):
    """多码率挂载点（B3）：/stream/64、/stream/320 等。"""
    if bitrate not in config.TRANSCODE_MOUNTS:
        return "unknown mount", 404
    gen = mount_stream(station, bitrate)
    return _make_stream_response(gen, 0, force_mp3=True, br=bitrate)


@app.route("/api/status")
def api_status():
    return jsonify(station.status())


@app.route("/api/skip", methods=["POST"])
@auth.api_login_required
def api_skip():
    station.next()
    return jsonify({"ok": True})


@app.route("/api/play", methods=["POST"])
@auth.api_login_required
def api_play():
    # 兼容旧版 /api/pause 的 toggle，新接口 /api/play 只负责恢复播放
    if station.paused:
        station.toggle_pause()
    return jsonify({"ok": True, "paused": False})


@app.route("/api/stop", methods=["POST"])
@auth.api_login_required
def api_stop():
    if not station.paused:
        station.toggle_pause()
    return jsonify({"ok": True, "paused": True})


@app.route("/api/pause", methods=["POST"])
@auth.api_login_required
def api_pause():
    paused = station.toggle_pause()
    return jsonify({"ok": True, "paused": paused})


@app.route("/api/shuffle", methods=["POST"])
@auth.api_login_required
def api_shuffle():
    sh = station.toggle_shuffle()
    return jsonify({"ok": True, "shuffle": sh})


@app.route("/api/rescan", methods=["POST"])
@auth.api_login_required
def api_rescan():
    n = station.rescan()
    return jsonify({"ok": True, "count": n})


@app.route("/api/volume", methods=["POST"])
@auth.api_login_required
def api_volume():
    """设置输出音量 (0-100)。通过调整广播缓冲读取增益实现。"""
    body = request.get_json(silent=True) or {}
    vol = int(body.get("level", 80))
    vol = max(0, min(100, vol))
    station.volume = vol
    return jsonify({"ok": True, "volume": vol})


@app.route("/api/repeat", methods=["POST"])
@auth.api_login_required
def api_repeat():
    """单曲循环开关。"""
    rp = station.toggle_repeat()
    return jsonify({"ok": True, "repeat": rp})


@app.route("/api/relay", methods=["POST"])
@auth.api_login_required
def api_relay():
    if request.is_json:
        body = request.json or {}
        url = body.get("url")
        urls = body.get("urls")   # D4 多源 failover
        name = body.get("name")
    else:
        url = request.form.get("url")
        urls = None
        name = request.form.get("name")
    # D4 多源：urls 列表优先，其次单 url
    target = urls if urls else url
    if not target:
        return jsonify({"ok": False, "error": "缺少 url 或 urls"}), 400
    station.set_relay(target, name)
    return jsonify({"ok": True, "url": station.current_relay_url(),
                    "sources": len(station.relay_urls)})


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


@app.route("/api/favorites", methods=["POST"])
@auth.api_login_required
def api_add_favorite():
    """把当前转播 / 浏览到的电台收藏到 presets.json（去重 + 原子写）。"""
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
@auth.api_login_required
def api_relay_stop():
    station.stop_relay()
    return jsonify({"ok": True})


@app.route("/api/musickit", methods=["POST"])
@auth.api_login_required
def api_musickit():
    """F 层：musickit 随机渲染源控制。
    body: {"action":"start"|"stop", "channel":"random"|slug, "bars":32}
    开始后电台改用 musickit 随机渲染代替本地 music/ 歌单。"""
    body = request.get_json(silent=True) or {}
    action = (body.get("action") or "start").strip().lower()
    if action == "stop":
        station.stop_musickit()
        return jsonify({"ok": True, "mode": station.mode})
    channel = (body.get("channel") or "").strip() or None
    bars = body.get("bars")
    try:
        station.start_musickit(channel=channel, bars=bars)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "mode": station.mode,
                    "musickit": station.musickit.status()})


@app.route("/api/record", methods=["POST"])
@auth.api_login_required
def api_record():
    """录音开关（B2）：{"action":"start"|"stop"}。开启后广播被录成干净 MP3。"""
    if not transcoder.ffmpeg_available():
        return jsonify({"ok": False, "error": "本机没有 ffmpeg，无法录音"}), 500
    body = request.get_json(silent=True) or {}
    action = (body.get("action") or "start").strip().lower()
    if action == "stop":
        station.stop_recording()
        return jsonify({"ok": True, "recording": False})
    path = station.start_recording()
    return jsonify({"ok": True, "recording": True, "path": path})


@app.route("/api/request", methods=["POST"])
def api_request():
    """点歌：把歌单内某首加入播放队列（当前曲结束后优先播放）。"""
    if request.is_json:
        body = request.json or {}
    else:
        body = request.form or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"ok": False, "error": "缺少 title"}), 400
    # 只允许歌单内存在的曲目
    pl_idx = station._find_request_index(title)
    if pl_idx is None:
        return jsonify({"ok": False, "error": "歌单里没有这首"}), 404
    station.request_track(title)
    return jsonify({"ok": True, "queue": list(station.requests)})


# ---------- C1：本地歌曲标签 + 内嵌封面（纯 mutagen，无外部网络）----------

@app.route("/api/meta")
def api_meta():
    """返回当前/指定本地歌曲的标签。?path= 可选；缺省取正在播放的本地文件。"""
    path = request.args.get("path") or station.current_path()
    if not path or station.mode == "relay":
        return jsonify({})
    return jsonify(metadata.get_meta(path))


@app.route("/api/cover")
def api_cover():
    """返回当前/指定本地歌曲的封面：本地内嵌优先，无则查 iTunes（E3，零密钥）。"""
    path = request.args.get("path") or station.current_path()
    if not path or station.mode == "relay":
        return ("", 404)
    cov = metadata.get_cover_smart(path)
    if not cov:
        return ("", 404)
    data, mime = cov
    return Response(data, mimetype=mime)


@app.route("/api/lyrics")
def api_lyrics():
    """C2 歌词：本地 LRC 优先，失败回退 LRCLIB（keyless）。
    ?path= 指定文件；缺省取当前曲。relay 模式尝试用标题解析 'Artist - Title'。"""
    path = request.args.get("path") or station.current_path()
    if not path or station.mode == "relay":
        t = station.current_title or ""
        artist, title = "", t
        if " - " in t:
            artist, title = t.split(" - ", 1)
        if title:
            return jsonify(lyrics.get_lyrics(title=title.strip(), artist=artist.strip()))
        return jsonify({})
    meta = metadata.get_meta(path)
    return jsonify(lyrics.get_lyrics(
        path=path, title=meta.get("title"), artist=meta.get("artist")))


# ---------- C4：PWA 可安装（manifest / service worker / 图标）----------

@app.route("/manifest.webmanifest")
def pwa_manifest():
    return send_file(os.path.join(_PWA_DIR, "manifest.webmanifest"),
                     mimetype="application/manifest+json")


@app.route("/sw.js")
def pwa_sw():
    return send_file(os.path.join(_PWA_DIR, "sw.js"),
                     mimetype="application/javascript")


@app.route("/icon-192.png")
@app.route("/icon-512.png")
def pwa_icon():
    name = "icon-512.png" if request.path.endswith("512.png") else "icon-192.png"
    return send_file(os.path.join(_PWA_DIR, name), mimetype="image/png")


# ---------- C5：播客 RSS（基于录音存档 recordings/）----------

@app.route("/recordings/<name>")
def recordings_file(name):
    """提供录音文件（供 RSS enclosure 与直接收听）。防目录穿越。"""
    name = os.path.basename(name)
    p = os.path.join(config.RECORD_DIR, name)
    if not os.path.isfile(p):
        return ("", 404)
    return send_file(p, mimetype="audio/mpeg", conditional=True)


@app.route("/rss")
def rss():
    """生成播客 RSS 2.0（遍历 recordings/*.mp3）。空目录也返回合法空频道。"""
    import email.utils
    import xml.sax.saxutils as su

    items = []
    if os.path.isdir(config.RECORD_DIR):
        for fn in sorted(os.listdir(config.RECORD_DIR)):
            if not fn.lower().endswith(".mp3"):
                continue
            p = os.path.join(config.RECORD_DIR, fn)
            if not os.path.isfile(p):
                continue
            mtime = os.path.getmtime(p)
            title = fn
            if title.startswith("rec_"):
                title = title[4:]
            title = os.path.splitext(title)[0].replace("_", " ")
            items.append((mtime, fn, title))
    items.sort(reverse=True)

    base = request.host_url.rstrip("/")
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0"><channel>',
        f"<title>{su.escape(station.station_name)} 播客</title>",
        f"<link>{su.escape(base + '/')}</link>",
        "<description>电台录音存档</description>",
        f"<lastBuildDate>{email.utils.formatdate(time.time(), usegmt=True)}</lastBuildDate>",
    ]
    for mtime, fn, title in items:
        url = base + "/recordings/" + quote(fn)
        size = os.path.getsize(os.path.join(config.RECORD_DIR, fn))
        pub = email.utils.formatdate(mtime, usegmt=True)
        out += [
            "<item>",
            f"<title>{su.escape(title)}</title>",
            f"<link>{su.escape(url)}</link>",
            f"<guid>{su.escape(url)}</guid>",
            f"<pubDate>{pub}</pubDate>",
            f'<enclosure url="{su.escape(url)}" length="{size}" type="audio/mpeg"/>',
            "</item>",
        ]
    out.append("</channel></rss>")
    return Response("\n".join(out), mimetype="application/rss+xml")


# ---------- C3：社群同步（Discord / Telegram）----------

@app.route("/api/integrations", methods=["GET", "POST"])
def api_integrations():
    """GET 返回启用状态（布尔，不泄露密钥）；POST 保存配置（原子写 integrations.json，需登录）。"""
    if request.method == "POST":
        if not session.get("logged_in"):
            return jsonify({"ok": False, "error": "请先登录"}), 401
        body = request.get_json(silent=True) or {}
        return jsonify(integrations.save(body))
    return jsonify(integrations.status())


@app.route("/api/announce", methods=["POST"])
@auth.api_login_required
def api_announce():
    """立刻把当前曲发布到已配置的 Discord/Telegram（扩展"立即发布"按钮）。"""
    with app.app_context():
        pass
    s = station.status()
    artist = None
    title = s.get("current_title")
    path = station.current_path()
    if s.get("mode") == "playlist" and path:
        try:
            artist = metadata.get_meta(path).get("artist")
        except Exception:
            artist = None
    ok = integrations.announce_now(title, artist, path, s.get("mode", "playlist"))
    return jsonify({"ok": ok})


@app.route("/api/request/clear", methods=["POST"])
@auth.api_login_required
def api_request_clear():
    """清空点歌队列。"""
    station.requests.clear()
    return jsonify({"ok": True})


# ── 收藏电台（旧的 /api/presets 重定向为 /api/favorites） ──

@app.route("/api/favorites", methods=["GET"])
def api_list_favorites():
    """列出已收藏的电台。"""
    return jsonify({"ok": True, "favorites": load_presets()})


# ---------- D4：网络监控（健康检查 + 听众日志）----------

@app.route("/api/health")
def api_health():
    """服务健康检查：流模式 / 听众数 / uptime / 磁盘 / HLS / 隧道。"""
    import shutil
    s = station.status()
    pub = read_public_url()
    # 磁盘空间（音乐目录所在盘）
    disk = {"free_gb": None, "total_gb": None}
    try:
        du = shutil.disk_usage(config.MUSIC_DIR)
        disk = {"free_gb": round(du.free / 1e9, 2), "total_gb": round(du.total / 1e9, 2)}
    except Exception:
        pass
    return jsonify({
        "ok": True,
        "mode": s["mode"],
        "current_title": s["current_title"],
        "listeners": s["listeners"],
        # 订阅队列数：应与在线听众数同量级；异常膨胀 = 订阅泄漏（见 Broadcaster.sub_count）
        "subscribers": _broadcaster.sub_count(),
        "uptime": s["uptime"],
        "playlist_size": s["playlist_size"],
        "recording": s["recording"],
        "relay_sources": len(s.get("relay_urls", [])),
        "public_url": pub,
        "disk": disk,
        "hls": hls.status(),
        # 转播/切片能力诊断：新机器克隆仓库常见缺失（ffmpeg 二进制、可选 requests）
        "ffmpeg": transcoder.ffmpeg_available(),
        "ffmpeg_path": config.FFMPEG,
        "deps": {
            "requests": _has_requests(),
            "waitress": _has_waitress(),
        },
    })


def _has_requests():
    try:
        import requests  # noqa: F401
        return True
    except Exception:
        return False


def _has_waitress():
    try:
        import waitress  # noqa: F401
        return True
    except Exception:
        return False


@app.route("/api/listeners")
def api_listeners():
    """D4 听众连接日志：最近 N 条 + 当前在线（IP/UA/时长，内存环不落盘）。"""
    return jsonify(station.listeners_recent())


@app.route("/api/stats/listeners")
def api_stats_listeners():
    """E4 听众历史统计：24h 曲线/峰值/Top IP/热门时段。"""
    hours = request.args.get("hours", 24, type=int)
    return jsonify(stats.listener_stats(hours))


# ---------- D1：HLS 直播分片 ----------

@app.route("/hls/<name>", methods=["GET", "HEAD", "OPTIONS"])
def hls_file(name):
    """HLS 切片静态服务：.m3u8 + .ts，防目录穿越。

    响应头很关键：
    - playlist 必须 no-store。套了 Cloudflare/cloudflared 后，被 CDN 或浏览器缓存住
      的 .m3u8 会让客户端永远拿不到新切片，直播表现为"卡住不动"。
    - 切片名唯一且内容不变，可以长缓存（immutable），省带宽。
    - CORS 全开，方便把公网地址嵌到任意页面/第三方播放器。
    """
    if request.method == "OPTIONS":
        resp = app.make_default_options_response()
    else:
        name = os.path.basename(name)
        p = os.path.join(hls.HLS_DIR, name)
        if not os.path.isfile(p):
            return ("", 404)
        is_playlist = name.endswith(".m3u8")
        mime = "application/vnd.apple.mpegurl" if is_playlist else "video/mp2t"
        # playlist 不做条件请求，避免 ETag/304 把旧列表钉死
        resp = send_file(p, mimetype=mime, conditional=not is_playlist, max_age=0)
        if is_playlist:
            resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        else:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Range, Origin, Accept"
    resp.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range"
    return resp


@app.route("/api/hls/status")
def api_hls_status():
    """HLS 切片器状态（运行中/重启次数/m3u8 是否生成/最后错误）。"""
    return jsonify(hls.status())


# ---------- E1：节目单/定时播放 ----------

@app.route("/api/schedule", methods=["GET", "POST"])
def api_schedule():
    """GET 返回排程 + 即将触发 + 开关；POST 原子写 schedule.json（需登录）。"""
    if request.method == "POST":
        if not session.get("logged_in"):
            return jsonify({"ok": False, "error": "请先登录"}), 401
        body = request.get_json(silent=True) or {}
        items = body.get("items") if isinstance(body, dict) else body
        if not isinstance(items, list):
            return jsonify({"ok": False, "error": "items 必须是数组"}), 400
        try:
            schedule.save_schedule(items)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500
        return jsonify({"ok": True, "count": len(items)})
    return jsonify({
        "enabled": schedule.is_enabled(),
        "items": schedule.load_schedule(),
        "upcoming": schedule.upcoming(station, 5),
    })


@app.route("/api/schedule/enable", methods=["POST"])
@auth.api_login_required
def api_schedule_enable():
    body = request.get_json(silent=True) or {}
    v = body.get("enabled")
    if v is not None:
        schedule.set_enabled(bool(v))
    return jsonify({"ok": True, "enabled": schedule.is_enabled()})


@app.after_request
def _cors(resp):
    """允许扩展 popup（跨域 localhost）访问 API；本地电台无风险。"""
    p = request.path
    if p.startswith("/api/") or p in ("/manifest.webmanifest", "/sw.js"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp
