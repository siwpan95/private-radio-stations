"""D2 共享广播缓冲：一个全局生产者读源 → 多听众 queue 订阅分发。

取代"每听众独立读文件"模型：
- 广播者单线程读源（playlist 文件 / relay 流），按 ICY_METAINT 读 chunk + 比特率节流
- 每个听众连接订阅一个 queue.Queue，广播者把 chunk 推给所有 queue
- 慢客户端背压：queue 满（maxsize=64）丢最旧块，听众跳秒不断流
- relay 模式广播者顺便 tee 录音（relay chunk 已是 MP3，干净）
- playlist 录音仍走 mount_stream per-listener（转码保证干净 MP3），广播者不插手

收益：N 个听众 = 1 次磁盘读（原来 N 次），磁盘 IO 不随听众数线性增长。
"""
import os
import queue
import sys
import threading
import time
import traceback

from . import config
from .mp3info import probe_audio
from .station import _display_title
from . import transcoder


def _duration(path):
    """用 mutagen 读音频时长（秒）。失败返回 None。E2 crossfade 用。"""
    try:
        from mutagen import File as MF
        a = MF(path)
        return a.info.length if a and a.info else None
    except Exception:
        return None


class Broadcaster:
    def __init__(self, station):
        self.station = station
        self._lock = threading.Lock()
        self._subs = []          # list of queue.Queue
        self._thread = None
        self._stop = False

    def start(self):
        if self._thread and self._thread.is_alive():
            return False
        self._stop = False
        self._thread = threading.Thread(target=self._run, daemon=True, name="broadcaster")
        self._thread.start()
        return True

    def stop(self):
        self._stop = True

    def subscribe(self):
        """听众连入，返回一个订阅 queue（maxsize=64，背压丢旧块）。"""
        q = queue.Queue(maxsize=64)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            try:
                self._subs.remove(q)
            except ValueError:
                pass

    def has_subscribers(self):
        with self._lock:
            return len(self._subs) > 0

    def sub_count(self):
        """当前订阅队列数。正常应等于在线听众数；持续高于听众数说明
        generator 的 finally 没跑到（客户端异常断开），订阅泄漏会让 _push
        逐帧空转在几百个死队列上，整台随运行时长越跑越慢。"""
        with self._lock:
            return len(self._subs)

    def _push(self, chunk):
        """把音频 chunk 推给所有订阅者；满 queue 丢最旧块（背压）。"""
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(chunk)
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(chunk)
                except queue.Full:
                    pass

    def _record_tee(self, chunk):
        """relay 模式录音：relay chunk 已是 MP3，追加到录音文件安全。
        playlist 录音走 mount_stream per-listener（转码），广播者不插手。"""
        st = self.station
        if st.mode == "relay" and st.recording and st.recording_path:
            try:
                with open(st.recording_path, "ab") as f:
                    f.write(chunk)
            except Exception:
                pass

    # ---------- 主循环 ----------
    def _run(self):
        st = self.station
        while not self._stop:
            try:
                with st.lock:
                    mode = st.mode
                if mode == "relay":
                    self._run_relay()
                elif mode == "musickit":
                    self._run_musickit()
                else:
                    self._run_playlist()
            except Exception:
                print("[broadcaster ERROR]", traceback.format_exc(), file=sys.stderr, flush=True)
                time.sleep(0.5)

    # ---------- playlist 源 ----------
    def _run_playlist(self):
        st = self.station
        chunk_size = config.ICY_METAINT if config.ICY_METAINT > 0 else config.CHUNK_SIZE
        while not self._stop:
            with st.lock:
                if st.mode != "playlist":
                    return   # 切到 relay，让 _run 重选源
                if st.paused:
                    path = None
                else:
                    path = st.current_path()
            if st.paused:
                time.sleep(0.2)
                continue
            if not path:
                time.sleep(1.0)
                continue

            # 点歌优先
            while True:
                req = st.pop_request()
                if not req:
                    break
                pl_idx = st._find_request_index(req)
                if pl_idx is not None:
                    st.jump_to_playlist_index(pl_idx)
                    path = st.current_path()
                    break

            st.set_title(_display_title(path))
            st.record_history(st.current_title)
            st.notify_track(path, st.current_title, "playlist")

            # E2：CROSSFADE 开启时用 ffmpeg 转码带淡入淡出；否则原始字节（现状）
            if getattr(config, "CROSSFADE", False) and transcoder.ffmpeg_available():
                dur = _duration(path)
                gen = (transcoder.transcode_fade(path, config.DEFAULT_BITRATE, dur,
                                                 getattr(config, "CROSSFADE_SEC", 2.0))
                       if dur else transcoder.transcode(path, config.DEFAULT_BITRATE))
                try:
                    for chunk in gen:
                        if st.mode != "playlist":
                            return   # 切 relay
                        if st.next_event.is_set():
                            st._advance()
                            break
                        if st.paused:
                            while st.paused and st.mode == "playlist":
                                time.sleep(0.2)
                            continue
                        if self.has_subscribers():
                            self._push(chunk)
                    if not st.next_event.is_set():
                        st._advance()   # 本首自然播完
                finally:
                    gen.close()
            else:
                probe = probe_audio(path)
                flood = probe["bitrate"] is None
                bps = 0.0 if flood else max(1.0, probe["bitrate"] * 1000 / 8)

                try:
                    f = open(path, "rb")
                except OSError:
                    st._advance()
                    continue

                with f:
                    while not self._stop:
                        if st.mode != "playlist":
                            return   # 切 relay
                        if st.next_event.is_set():
                            st._advance()
                            break
                        if st.paused:
                            while st.paused and st.mode == "playlist":
                                time.sleep(0.2)
                            continue
                        data = f.read(chunk_size)
                        if not data:
                            st._advance()   # 本首自然播完
                            break
                        # 有订阅者才入队（省 CPU），但始终节流保持节奏
                        if self.has_subscribers():
                            self._push(data)
                        if bps > 0:
                            time.sleep(len(data) / bps)

    # ---------- musickit 随机渲染源 ----------
    def _run_musickit(self):
        """F 层：把 musickit 随机渲染的曲目推成连续广播。

        与 playlist 源共用同一套推送/节流逻辑；区别是「下一首」来自
        MusickitSource 的就绪队列（后台线程持续预渲染），而不是磁盘歌单。
        """
        st = self.station
        src = st.musickit
        chunk_size = config.ICY_METAINT if config.ICY_METAINT > 0 else config.CHUNK_SIZE
        while not self._stop:
            with st.lock:
                if st.mode != "musickit":
                    return
                if st.paused:
                    time.sleep(0.2)
                    continue
            # 阻塞等一首渲染完成（渲染中约 15~30s/首，队列深度见 config）
            meta = src.wait_current(1.0)
            if meta is None:
                continue   # 源被停止 / 模式切换，让 _run 重新分派
            with st.lock:
                if st.mode != "musickit":
                    return   # 等待期间已切到转播/歌单：不设标题不播音
            path = meta["file"]
            if not os.path.isfile(path):
                continue

            st.set_title(meta.get("title") or _display_title(path))
            st.record_history(st.current_title)
            st.notify_track(path, st.current_title, "musickit")

            # 推流节奏：优先用渲染器给出的真实时长（字节数/时长 = 真实码率），
            # 避免 MP3 帧头探测不准导致的两种极端 —— 探测失败时洪水式快进、
            # 探测偏低时慢放（渲染件 VBR 首帧常见 64k，远低于真实码率）。
            dur = 0.0
            try:
                dur = float(meta.get("duration_s") or 0)
            except (TypeError, ValueError):
                dur = 0.0
            if dur > 0:
                bps = max(1.0, os.path.getsize(path) / dur)
            else:
                probe = probe_audio(path)
                br = probe.get("bitrate") or config.DEFAULT_BITRATE
                bps = max(1.0, br * 1000 / 8)
            try:
                f = open(path, "rb")
            except OSError:
                continue

            with f:
                while not self._stop:
                    if st.mode != "musickit":
                        return
                    if st.next_event.is_set():
                        st.musickit_advance()   # 跳下一首（队列空则等下一首渲染完）
                        break
                    if st.paused:
                        while st.paused and st.mode == "musickit":
                            time.sleep(0.2)
                        continue
                    data = f.read(chunk_size)
                    if not data:
                        st.musickit_advance()   # 本首自然播完
                        break
                    if self.has_subscribers():
                        self._push(data)
                    if bps > 0:
                        time.sleep(len(data) / bps)

    # ---------- relay 源 ----------
    def _run_relay(self):
        st = self.station
        url = st.current_relay_url()
        if not url:
            time.sleep(1.0)
            return

        use_transcode = False
        if config.TRANSCODE_RELAY and transcoder.ffmpeg_available():
            codec = transcoder.probe_remote_codec(url)
            if codec is None or codec.lower() != "mp3":
                use_transcode = True

        if use_transcode:
            gen = transcoder.transcode(url, config.TRANSCODE_BITRATE)
            if transcoder.ffmpeg_available():
                gen = transcoder.chain(transcoder.jingle_prefix(), gen)
        else:
            if not transcoder.ffmpeg_available():
                # 无 ffmpeg 时直连：非 MP3 源在浏览器会无声，面板给出明确提示
                _r, ctype = transcoder.peek_http_headers(url)
                if _r is not None:
                    try:
                        _r.close()
                    except Exception:
                        pass
                if ctype and "mpeg" not in ctype:
                    st.set_title(st.current_title + "（源非 MP3 且本机无 ffmpeg，浏览器可能无声）")
            gen = self._relay_passthrough(url)

        try:
            for chunk in gen:
                if st.mode != "relay":
                    return
                if st.next_event.is_set():
                    return   # stop_relay 触发，让 _run 切 playlist
                if self.has_subscribers():
                    self._push(chunk)
                self._record_tee(chunk)
        except Exception:
            # 转码分支失败：计数 + failover
            if use_transcode and st.mode == "relay":
                with st.lock:
                    st._relay_failures += 1
                    fails = st._relay_failures
                if fails >= 3:
                    if st.advance_relay_url():
                        return   # 切下一源，_run 重进 _run_relay
                    st.set_title("全部转播源中断，已自动回退到本地歌单")
                    st.record_history(st.current_title)
                    st.stop_relay()
                else:
                    time.sleep(2.0)

    def _relay_passthrough(self, url):
        """直连分支：原样代理远程 MP3 流（带节奏 + 失败 failover）。

        纯标准库（urllib）实现：不依赖 requests，新机器克隆仓库即用。"""
        bps = config.DEFAULT_BITRATE * 1000 / 8
        try:
            resp = transcoder.http_open(url, timeout=12)
            with self.station.lock:
                self.station._relay_failures = 0   # 连上了，清零失败计数
            while True:
                chunk = resp.read(config.CHUNK_SIZE)
                if self.station.mode != "relay":
                    break
                if not chunk:
                    break
                yield chunk
                time.sleep(len(chunk) / bps)
        except Exception:
            with self.station.lock:
                self.station._relay_failures += 1
                fails = self.station._relay_failures
            if fails >= 3:
                if self.station.advance_relay_url():
                    return   # 切下一源
                self.station.set_title("全部转播源中断，已自动回退到本地歌单")
                self.station.record_history(self.station.current_title)
                self.station.stop_relay()
            else:
                time.sleep(2.0)
