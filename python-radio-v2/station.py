"""电台核心状态：转播控制（线程安全）。

本版只做转播（relay）。所有可变状态包在 self.lock 里，
Web 接口、流生成器、HLS 管理器都可以安全读写。

支持「多源 failover」：可以给一个主源 + 若干备用源（手动增加），
主源连续失败会自动切到下一个，全部断了回到空闲（idle）。
"""
import threading

from . import config


class RadioStation:
    def __init__(self):
        self.lock = threading.RLock()

        self.mode = "idle"        # 'idle' | 'relay'
        self.relay_url = ""       # 当前正在转播的源
        self.relay_name = ""      # 显示名（可选）
        self.fallbacks = []       # 备用源列表（url 字符串）
        self._failures = 0        # 当前源连续失败计数

        self.current_title = "（未转播，请在右侧输入电台或点预设）"
        self.listeners = 0

        self.station_name = config.STATION_NAME
        self.genre = config.STATION_GENRE

    # ---------- 转播控制 ----------
    def set_relay(self, url, name=None, fallbacks=None):
        """开始转播 url；可选 name 用于显示，fallbacks 为备用源列表。"""
        if not url:
            return
        with self.lock:
            self.relay_url = url
            self.relay_name = (name or "").strip()
            self.fallbacks = list(fallbacks or [])
            self._failures = 0
            self.mode = "relay"
            self.current_title = self.relay_name or f"转播：{url}"

    def stop_relay(self):
        """停止转播，回到空闲。"""
        with self.lock:
            self.mode = "idle"
            self.relay_url = ""
            self.relay_name = ""
            self.fallbacks = []
            self._failures = 0
            self.current_title = "（未转播）"

    def set_title(self, t):
        with self.lock:
            self.current_title = t

    def note_failure(self):
        """当前源失败一次。返回是否应切换到下一个备用源。"""
        with self.lock:
            self._failures += 1
            if self._failures >= 3 and self.fallbacks:
                self._advance()
                return True
            return False

    def _advance(self):
        """切到下一个备用源（队列轮转）。全部用完则回空闲。"""
        if not self.fallbacks:
            self.mode = "idle"
            self.relay_url = ""
            self.current_title = "（全部转播源中断，请重新选择）"
            return
        self.fallbacks.append(self.relay_url)   # 当前主源移到队尾
        self.relay_url = self.fallbacks.pop(0)
        self._failures = 0
        self.current_title = f"转播（failover）：{self.relay_url}"

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
                "listeners": self.listeners,
                "relay_url": self.relay_url,
                "relay_name": self.relay_name,
                "fallbacks": len(self.fallbacks),
                # 前端可直接拼：<base>/hls/live.m3u8
                "hls_url": "/hls/live.m3u8",
                "mounts": list(config.TRANSCODE_MOUNTS),
            }
