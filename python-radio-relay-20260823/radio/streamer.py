"""流生成器：把歌单变成持续不断的音频流。

- playlist_stream：本地歌单流，支持 ICY 元数据（让播放器显示 “正在播放”）。
- relay_stream：转播另一个网络电台（代理其 HTTP 音频流）。

节奏控制：根据文件比特率（MP3 帧头嗅探）计算每秒应发送的字节数，
让客户端平滑缓冲，而不是一瞬间灌满。
"""
import queue
import time

from . import config
from .mp3info import probe_audio
from .station import _display_title
from . import transcoder


def _metadata_block(title, changed):
    """构造 ICY 元数据块。

    changed=False 时发送空块（仅 1 字节 0x00），节省带宽；
    changed=True 时发送 'StreamTitle=...;'，长度按 16 字节对齐。
    """
    if not changed:
        return b"\x00"
    meta = f"StreamTitle='{title}';".encode("utf-8", "replace")
    length = (len(meta) + 15) // 16
    padded = meta + b"\x00" * (length * 16 - len(meta))
    return bytes([length]) + padded


def playlist_stream(station, metaint=0, broadcaster=None):
    """D2 共享广播：订阅广播者 queue；metaint>0 时每 chunk 后插 ICY 元数据块。
    广播者按 ICY_METAINT 读 chunk，与 metaint 对齐，元数据插入位置正确。
    听众不 sleep（广播者已按比特率节流）；慢客户端由 queue 背压丢旧块。"""
    if broadcaster is None:
        return
    q = broadcaster.subscribe()
    last_title = None
    try:
        while True:
            try:
                chunk = q.get(timeout=30)
            except queue.Empty:
                continue
            yield chunk
            if metaint > 0:
                title = station.current_title
                changed = (title != last_title)
                last_title = title
                yield _metadata_block(title, changed)
    except GeneratorExit:
        pass
    finally:
        broadcaster.unsubscribe(q)


def relay_stream(station, metaint=0, broadcaster=None):
    """D2 共享广播：订阅广播者 queue（relay 始终 metaint=0，不插 ICY 元数据）。
    录音由广播者侧 tee（relay chunk 已是 MP3）；多源 failover 由广播者处理。"""
    if broadcaster is None:
        return
    q = broadcaster.subscribe()
    try:
        while True:
            try:
                chunk = q.get(timeout=30)
            except queue.Empty:
                continue
            yield chunk
    except GeneratorExit:
        pass
    finally:
        broadcaster.unsubscribe(q)
            # 否则（passthrough 自己已处理）回到顶部重试


def _relay_transcoded(station, url, bitrate):
    """转码分支：ffmpeg 把远程流转成固定 MP3。模式切走即停。"""
    for chunk in transcoder.transcode(url, bitrate):
        if station.mode != "relay":
            break
        yield chunk


def _relay_passthrough(station, url):
    """直连分支：原样代理远程 MP3 流（保留原有节奏控制与失败回退）。

    纯标准库（urllib）实现：不依赖 requests。"""
    bytes_per_sec = config.DEFAULT_BITRATE * 1000 / 8
    try:
        r = transcoder.http_open(url, timeout=12)
        with station.lock:
            station._relay_failures = 0   # 连上了，清零失败计数
        while True:
            chunk = r.read(config.CHUNK_SIZE)
            if station.mode != "relay":
                break
            if not chunk:
                break
            yield chunk
            time.sleep(len(chunk) / bytes_per_sec)
    except Exception:
        with station.lock:
            station._relay_failures += 1
            fails = station._relay_failures
        if fails >= 3:
            # D4 多源 failover：先切下一个源，全断才回退本地
            if station.advance_relay_url():
                return   # 结束本生成器，relay_stream 顶部取新源继续
            station.set_title("全部转播源中断，已自动回退到本地歌单")
            station.record_history(station.current_title)
            station.stop_relay()
        else:
            time.sleep(2.0)


def _pace(gen, bitrate, prebuffer=1.0, max_drift=5.0):
    """按目标码率节流，让挂载点表现得像真正的直播流。

    为什么必须有：/stream/<bitrate> 是 per-listener 转码，ffmpeg 转多快就吐多快。
    浏览器/播放器读得慢，靠 TCP 背压自然把服务端拖到实时速度，所以问题一直没暴露；
    但 ffmpeg 这类“全速读”的客户端会以几十倍实时速度抽干节目（实测约 29x），
    HLS 切片于是飞速产出又被 delete_segments 立刻删掉，客户端一取就 404。
    节流放在服务端而不是给 ffmpeg 加 -re，是为了根治所有快读客户端。

    prebuffer: 允许领先的秒数（起播不至于太慢）
    max_drift: 落后超过这么多秒就重置基准，避免源卡顿恢复后疯狂追赶
    """
    bytes_per_sec = max(int(bitrate or config.DEFAULT_BITRATE), 1) * 1000 / 8
    sent = 0
    t0 = time.monotonic()
    for chunk in gen:
        yield chunk
        if not chunk:
            continue
        sent += len(chunk)
        ahead = sent / bytes_per_sec - (time.monotonic() - t0)
        if ahead > prebuffer:
            time.sleep(min(ahead - prebuffer, 2.0))
        elif ahead < -max_drift:
            t0 = time.monotonic() - sent / bytes_per_sec


def mount_stream(station, bitrate, record_path=None):
    """多码率挂载点（B3）：把当前广播转码成指定码率 MP3。

    随模式切换（歌单/转播）自动适配音源；支持开场 jingle 与可选录音。
    输出经 _pace 按码率节流，保证 ffmpeg / 下载器等快读客户端也拿到实时速率。
    """
    while True:
        with station.lock:
            mode = station.mode
        if mode == "relay":
            gen = _relay_transcoded(station, station.relay_url, bitrate)
        elif mode == "musickit":
            gen = _musickit_transcoded(station, bitrate)
        else:
            gen = _playlist_transcoded(station, bitrate)

        if transcoder.ffmpeg_available():
            gen = transcoder.chain(transcoder.jingle_prefix(), gen)
        if record_path:
            gen = transcoder.record_tee(gen, record_path)
        gen = _pace(gen, bitrate)   # 最后一道：按码率匀速吐字节

        try:
            yield from gen
        except GeneratorExit:
            break
        time.sleep(0.1)   # 模式切换后的小缓冲


def _playlist_transcoded(station, bitrate):
    """歌单模式逐首转码（B3 挂载点用）：支持暂停/下一首/点歌。"""
    while station.mode == "playlist":
        if station.paused:
            while station.paused:
                time.sleep(0.2)

        # 点歌优先
        req = station.pop_request()
        if req:
            pl_idx = station._find_request_index(req)
            if pl_idx is not None:
                station.jump_to_playlist_index(pl_idx)

        path = station.current_path()
        if not path:
            time.sleep(1.0)
            continue

        station.set_title(_display_title(path))
        station.record_history(station.current_title)
        station.notify_track(path, station.current_title, "playlist")

        tgen = transcoder.transcode(path, bitrate)
        try:
            for chunk in tgen:
                if station.next_event.is_set():
                    station._advance()
                    break
                if station.paused:
                    while station.paused:
                        time.sleep(0.2)
                yield chunk
            else:
                station._advance()   # 本首播完
        finally:
            tgen.close()             # 确保 ffmpeg 进程被回收


def _musickit_transcoded(station, bitrate):
    """musickit 随机渲染源逐首转码（B3 挂载点用）。

    只「跟随」广播者当前在播的渲染文件，**不消费渲染队列**
    （队列只由广播者消费；否则 HLS 切片等挂载点会抢走曲目，主 /stream 断流）。
    切歌跟随 next_event 或当前文件变化；广播者还在播同一首时等待。
    """
    src = station.musickit
    last_path = None
    while station.mode == "musickit":
        if station.paused:
            while station.paused:
                time.sleep(0.2)

        path = src.current_path()
        if not path:
            time.sleep(1.0)
            continue
        if path == last_path:
            # 广播者还没推进到下一首：短暂等待（切歌跟随 current 变化）
            time.sleep(0.2)
            continue
        last_path = path

        station.set_title(src.current_title() or _display_title(path))
        station.record_history(station.current_title)
        station.notify_track(path, station.current_title, "musickit")

        tgen = transcoder.transcode(path, bitrate)
        try:
            for chunk in tgen:
                if station.mode != "musickit":
                    return
                # 广播者切歌（跳过或自然播完）→ 跟随新曲目
                if station.next_event.is_set() or src.current_path() != path:
                    break
                if station.paused:
                    while station.paused and station.mode == "musickit":
                        time.sleep(0.2)
                    continue
                yield chunk
            else:
                # 本首转码完毕：广播者可能还在播同一首，回到顶部等待推进
                time.sleep(0.2)
        finally:
            tgen.close()             # 确保 ffmpeg 进程被回收
