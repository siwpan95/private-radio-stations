"""HLS 直播切片：把当前转播流切成 hls/live.m3u8 + .ts 分片。

由 ffmpeg 在后台持续运行；转播开始/切换 URL 时（重）启动，停止转播时关闭。
前端用 <audio>/<video> 直接播 /hls/live.m3u8 即可低延迟收听。

ffmpeg 不可用时（HLS_DIR 无 ffmpeg），所有方法静默降级，不影响主 /stream。
"""
import os
import threading
import subprocess

from . import config


class HlsManager:
    def __init__(self):
        self.lock = threading.RLock()
        self.proc = None
        self.url = None
        os.makedirs(config.HLS_DIR, exist_ok=True)

    def enabled(self):
        """ffmpeg 可用且配置了切片目录。"""
        return ffmpeg_ok() and os.path.isdir(config.HLS_DIR)

    def start(self, url):
        """开始 / 重启切片到 url。url 与当前一致则忽略。"""
        if not self.enabled() or not url:
            return
        with self.lock:
            if self.proc is not None and self.url == url:
                return
            self.stop_locked()
            self._clean_segments()
            cmd = [
                config.FFMPEG, "-hide_banner", "-loglevel", "error",
                "-i", url,
                "-c:a", "copy",            # 源多为 mp3/aac，直接封装零 CPU
                "-f", "hls",
                "-hls_time", str(config.HLS_SEGMENT_SEC),
                "-hls_list_size", str(config.HLS_LIST_SIZE),
                "-hls_flags", "delete_segments+append_list",
                "-hls_delete_threshold", str(config.HLS_DELETE_THRESHOLD),
                os.path.join(config.HLS_DIR, "live.m3u8"),
            ]
            try:
                self.proc = subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                self.url = url
            except Exception:
                self.proc = None
                self.url = None

    def stop(self):
        with self.lock:
            self.stop_locked()
        # 停止后清理分片，避免前端拿到过期 m3u8 一直转圈
        self._clean_segments()

    def stop_locked(self):
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
        self.url = None

    def _clean_segments(self):
        try:
            for fn in os.listdir(config.HLS_DIR):
                if fn.endswith(".ts") or fn == "live.m3u8":
                    try:
                        os.remove(os.path.join(config.HLS_DIR, fn))
                    except OSError:
                        pass
        except Exception:
            pass


_ffmpeg_cache = None
_ffmpeg_cache_lock = threading.Lock()


def ffmpeg_ok():
    global _ffmpeg_cache
    with _ffmpeg_cache_lock:
        if _ffmpeg_cache is not None:
            return _ffmpeg_cache
        try:
            subprocess.run([config.FFMPEG, "-version"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          timeout=10)
            _ffmpeg_cache = True
        except Exception:
            _ffmpeg_cache = False
        return _ffmpeg_cache


# 全局单例，web 层与 station 共用
hls_manager = HlsManager()
