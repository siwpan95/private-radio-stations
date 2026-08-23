"""电台核心状态：歌单管理 + 播放控制（线程安全）。

所有可变状态都包在 self.lock 里，播放生成器、Web 接口、定时器
都可以安全读写，不会互相踩。
"""
import os
import glob
import random
import threading
import collections
import time

from . import config
from . import stats
from . import musickit_source

# 支持的音频扩展名
AUDIO_EXTS = ("*.mp3", "*.MP3", "*.ogg", "*.OGG", "*.flac",
              "*.FLAC", "*.wav", "*.WAV")


def _display_title(path):
    """从文件名推导 “正在播放” 标题。"""
    name = os.path.basename(path)
    name = os.path.splitext(name)[0]
    name = name.replace("_", " ").replace("-", " ").strip()
    return name or "未知曲目"


class RadioStation:
    def __init__(self):
        self.lock = threading.RLock()

        self.music_dir = config.MUSIC_DIR
        self.playlist = []        # 绝对路径列表（按文件名排序）
        self.order = []           # 实际播放顺序（索引到 playlist）
        self.index = 0            # 当前在 order 中的位置
        self.shuffle = False
        self.repeat = False   # 单曲循环

        self.paused = False
        self.volume = 80      # 输出音量（百分比，0-100）
        self.next_event = threading.Event()

        self.mode = config.DEFAULT_SOURCE    # 'playlist' | 'relay' | 'musickit'
        # F 层：musickit 随机渲染源（代替本地 music/ 歌单）
        self.musickit = musickit_source.MusickitSource(self)
        self.relay_urls = []      # D4 多源 failover：转播源列表
        self.relay_index = 0      # 当前使用的源索引（失败自动切下一个）
        self.relay_url = ""       # 兼容属性：当前正在用的源 URL（= relay_urls[relay_index]）

        self.current_title = ""
        self.listeners = 0
        self._start_time = time.time()                       # D4 服务 uptime
        self._listener_log = collections.deque(maxlen=100)   # D4 听众连接日志（内存环，不落盘）
        self._online_listeners = {}                          # D4 lid -> {ip,ua,start}
        self._listener_seq = 0

        self.track_start = time.time()   # C2 同步歌词：当前曲开始时刻
        self._pause_elapsed = 0.0        # 暂停时冻结的已播秒数

        self.history = collections.deque(maxlen=50)   # 最近播放（本地+转播）
        self.requests = []                            # 点歌队列（歌单内曲名）
        self._relay_failures = 0                      # 转播连续失败计数（用于自动回退）

        self.recording = False                        # B2 是否正在录音
        self.recording_path = ""                      # B2 当前录音文件绝对路径

        self.station_name = config.STATION_NAME
        self.genre = config.STATION_GENRE

        self.rescan()
        # 默认音源是 musickit 随机渲染时，启动即开始预渲染
        if self.mode == "musickit":
            self.musickit.start()

    # ---------- 歌单 ----------
    def rescan(self):
        """扫描音乐目录，重建播放列表。"""
        with self.lock:
            songs = set()
            for ext in AUDIO_EXTS:
                songs.update(glob.glob(os.path.join(self.music_dir, ext)))
            # set 自动去重：Windows 上大小写扩展名会重复匹配同一个文件
            self.playlist = sorted(songs)
            self._rebuild_order(keep_index=False)
            if not self.playlist:
                self.current_title = ("（本地歌单为空 —— 默认已用 musickit 随机渲染代替；"
                                      "也可把歌曲放进 music/ 目录）")
        return len(self.playlist)

    def _rebuild_order(self, keep_index=True):
        n = len(self.playlist)
        if n == 0:
            self.order = []
            return
        order = list(range(n))
        if self.shuffle:
            random.shuffle(order)
        self.order = order
        if not keep_index or self.index >= len(order):
            self.index = 0

    def current_path(self):
        with self.lock:
            if not self.order or self.index >= len(self.order):
                return None
            return self.playlist[self.order[self.index]]

    # ---------- 播放控制 ----------
    def next(self):
        with self.lock:
            if self.mode not in ("playlist", "musickit"):
                return
            self.next_event.set()

    def _advance(self):
        """切到下一首（并清除 next 信号）。"""
        with self.lock:
            self.next_event.clear()
            if self.order:
                self.index = (self.index + 1) % len(self.order)

    def toggle_pause(self):
        with self.lock:
            self.paused = not self.paused
            # 暂停时冻结已播秒数，恢复后接着算（C2 同步歌词用）
            if self.paused:
                self._pause_elapsed = time.time() - self.track_start
            else:
                self.track_start = time.time() - self._pause_elapsed
        return self.paused

    def toggle_shuffle(self):
        with self.lock:
            self.shuffle = not self.shuffle
            self._rebuild_order(keep_index=True)
        return self.shuffle

    def toggle_repeat(self):
        with self.lock:
            self.repeat = not self.repeat
        return self.repeat

    # ---------- 点歌 ----------
    def _find_request_index(self, query: str) -> int:
        """模糊匹配歌名，返回 playlist 索引；-1 表示未找到。"""
        q = query.lower().strip()
        for i, p in enumerate(self.playlist):
            name = os.path.splitext(os.path.basename(p))[0].lower()
            if q in name:
                return i
        return -1

    def request_track(self, query: str) -> bool:
        """点歌：模糊匹配歌名，加入点歌队列头部（下次切歌优先播放）。"""
        idx = self._find_request_index(query)
        if idx < 0:
            return False
        with self.lock:
            # 避免重复
            if idx not in self.requests:
                self.requests.insert(0, idx)
        return True

    def set_relay(self, url, name=None):
        """开始转播。url 可以是单个字符串或字符串列表（D4 多源 failover）。"""
        urls = url if isinstance(url, (list, tuple)) else [url]
        urls = [u for u in urls if u]
        if not urls:
            return
        with self.lock:
            self.mode = "relay"
            self.relay_urls = urls
            self.relay_index = 0
            self.relay_url = urls[0]   # 兼容现有读取
            self._relay_failures = 0
            self.current_title = name or f"转播：{urls[0]}"
            self.record_history(self.current_title)
        self.notify_track(None, self.current_title, "relay")

    def current_relay_url(self):
        """当前正在使用的转播源 URL（多源 failover 时按索引取）。"""
        with self.lock:
            if not self.relay_urls:
                return ""
            idx = min(self.relay_index, len(self.relay_urls) - 1)
            return self.relay_urls[idx]

    def advance_relay_url(self):
        """当前源失败时切到下一个；成功切到返回 True，已是最后一个返回 False。"""
        with self.lock:
            if self.relay_index + 1 < len(self.relay_urls):
                self.relay_index += 1
                self.relay_url = self.relay_urls[self.relay_index]
                self._relay_failures = 0
                self.current_title = f"转播（源{self.relay_index + 1}/{len(self.relay_urls)}）：{self.relay_url}"
                self.record_history(self.current_title)
                return True
            return False

    def stop_relay(self):
        with self.lock:
            self.mode = config.DEFAULT_SOURCE
            self.relay_url = ""
            self.relay_urls = []
            self.relay_index = 0
            self.next_event.set()   # 触发切回默认音源

    # ---------- F 层：musickit 随机渲染源 ----------
    def start_musickit(self, channel=None, bars=None):
        """切到 musickit 随机渲染源：启动预渲染线程，广播者等第一首渲染完即开播。"""
        with self.lock:
            self.mode = "musickit"
            self.relay_url = ""
            self.relay_urls = []
            self.musickit.start(channel=channel, bars=bars)
            if not self.current_title or self.current_title.startswith("（"):
                self.current_title = "随机渲染准备中（首曲约 15~30 秒）…"
        self.next_event.set()

    def stop_musickit(self):
        """停止随机渲染源，切回本地歌单。"""
        self.musickit.stop()
        with self.lock:
            self.mode = "playlist"
        self.next_event.set()

    def musickit_advance(self):
        """随机渲染源切下一首（清除 next 信号 + 取队列里下一首）。"""
        with self.lock:
            self.next_event.clear()
            src = self.musickit
        return src.advance()

    def set_playlist_dir(self, dir):
        """E1 节目单：切换歌单目录并重新扫描，触发广播者切到新目录第一首。"""
        with self.lock:
            self.music_dir = dir
        self.rescan()
        self.next_event.set()   # 触发广播者切到新歌单

    # ---------- 录音（B2）----------
    def start_recording(self):
        """开始录音，返回录音文件绝对路径。已在进行则直接返回现有路径。"""
        import time
        with self.lock:
            if self.recording:
                return self.recording_path
            os.makedirs(config.RECORD_DIR, exist_ok=True)
            ts = time.strftime("%Y%m%d_%H%M%S")
            path = os.path.join(config.RECORD_DIR, f"rec_{ts}.mp3")
            self.recording = True
            self.recording_path = path
            return path

    def stop_recording(self):
        with self.lock:
            self.recording = False
            self.recording_path = ""

    def set_title(self, t):
        with self.lock:
            self.current_title = t

    def notify_track(self, path=None, title=None, mode="playlist"):
        """标记一首新曲开始（重置 elapsed 计时），并在启用社群同步时后台发布（C3）。"""
        with self.lock:
            self.track_start = time.time()
        try:
            from . import integrations
            integrations.maybe_announce(path=path, title=title, mode=mode)
        except Exception:
            pass

    # ---------- 听众计数 + 连接日志（D4）----------
    def add_listener(self, ip="", ua=""):
        """新听众连入。返回 lid 供 remove_listener 记录时长。"""
        with self.lock:
            self.listeners += 1
            self._listener_seq += 1
            lid = self._listener_seq
            self._online_listeners[lid] = {
                "ip": ip, "ua": ua, "start": time.time()
            }
        try:
            stats.log_connect(ip, ua)
        except Exception:
            pass
        return lid

    def remove_listener(self, lid=None):
        """听众断开，记录连接时长到内存环 + SQLite（E4）。"""
        info = None
        dur = 0
        with self.lock:
            self.listeners = max(0, self.listeners - 1)
            if lid and lid in self._online_listeners:
                info = self._online_listeners.pop(lid)
                dur = int(time.time() - info["start"])
                self._listener_log.append({
                    "ip": info["ip"], "ua": info["ua"],
                    "duration": dur,
                    "ended": int(time.time()),
                })
        if info:
            try:
                stats.log_disconnect(info["ip"], info["ua"], dur)
            except Exception:
                pass

    def listeners_recent(self, n=20):
        """最近 n 条听众连接 + 当前在线列表（D4 网络监控）。"""
        with self.lock:
            recent = list(self._listener_log)[-n:]
            online = [
                {"ip": v["ip"], "ua": v["ua"],
                 "elapsed": int(time.time() - v["start"])}
                for v in self._online_listeners.values()
            ]
            return {"recent": recent, "online": online, "online_count": len(online)}

    # ---------- 最近播放历史 ----------
    def record_history(self, title):
        if not title:
            return
        with self.lock:
            # 避免与最近一条重复
            if self.history and self.history[-1] == title:
                return
            self.history.append(title)

    # ---------- 点歌队列 ----------
    def request_track(self, title):
        with self.lock:
            self.requests.append(title)

    def pop_request(self):
        with self.lock:
            return self.requests.pop(0) if self.requests else None

    def _find_request_index(self, title):
        """在歌单里按文件名/显示名模糊匹配请求曲目，返回 playlist 索引或 None。"""
        with self.lock:
            low = (title or "").strip().lower()
            if not low:
                return None
            for i, p in enumerate(self.playlist):
                base = os.path.basename(p).lower()
                disp = _display_title(p).lower()
                if low in base or low in disp:
                    return i
        return None

    def jump_to_playlist_index(self, pl_idx):
        with self.lock:
            if pl_idx in self.order:
                self.index = self.order.index(pl_idx)

    # ---------- 对外状态 ----------
    def status(self):
        with self.lock:
            return {
                "station": self.station_name,
                "genre": self.genre,
                "mode": self.mode,
                "current_title": self.current_title,
                "paused": self.paused,
                "shuffle": self.shuffle,
                "listeners": self.listeners,
                "playlist_size": len(self.playlist),
                "musickit": self.musickit.status(),
                "relay_url": self.relay_url,
                "relay_urls": list(self.relay_urls),
                "relay_index": self.relay_index,
                "history": list(self.history),
                "requests": list(self.requests),
                "playlist": [os.path.basename(p) for p in self.playlist],
                "recording": self.recording,
                "recording_path": self.recording_path,
                "elapsed": int(time.time() - self.track_start),  # C2 同步歌词：当前曲已播秒数
                "uptime": int(time.time() - self._start_time),    # D4 服务运行时长
            }
