"""电台核心状态：歌单管理 + 播放控制（线程安全）。

所有可变状态都包在 self.lock 里，播放生成器、Web 接口、定时器
都可以安全读写，不会互相踩。
"""
import os
import glob
import random
import threading

from . import config

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

        self.paused = False
        self.next_event = threading.Event()

        self.mode = "playlist"    # 'playlist' | 'relay'
        self.relay_url = ""

        self.current_title = ""
        self.listeners = 0

        self.station_name = config.STATION_NAME
        self.genre = config.STATION_GENRE

        self.rescan()

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
                self.current_title = "（歌单为空，请把歌曲放进 music/ 目录）"
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
            if self.mode != "playlist":
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
        return self.paused

    def toggle_shuffle(self):
        with self.lock:
            self.shuffle = not self.shuffle
            self._rebuild_order(keep_index=True)
        return self.shuffle

    def set_relay(self, url, name=None):
        with self.lock:
            self.mode = "relay"
            self.relay_url = url
            self.current_title = name or f"转播：{url}"

    def stop_relay(self):
        with self.lock:
            self.mode = "playlist"
            self.relay_url = ""
            self.next_event.set()   # 触发切回歌单

    def set_title(self, t):
        with self.lock:
            self.current_title = t

    # ---------- 听众计数 ----------
    def add_listener(self):
        with self.lock:
            self.listeners += 1

    def remove_listener(self):
        with self.lock:
            self.listeners = max(0, self.listeners - 1)

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
                "relay_url": self.relay_url,
                "playlist": [os.path.basename(p) for p in self.playlist],
            }
