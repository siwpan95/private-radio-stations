"""E1 节目单/定时播放：schedule.json + 后台 cron 线程。

格式（schedule.json，数组）：
[
  {
    "name": "工作日白天",
    "time": "09:00",            // HH:MM（24h）
    "weekdays": [1,2,3,4,5],    // 1=周一 ... 7=周日；省略=每天
    "action": "playlist_dir",   // playlist_dir | relay | shuffle
    "dir": "music/light"        // playlist_dir: 歌单子目录；relay: url；shuffle: 无需参数
  },
  {
    "name": "周末摇滚夜",
    "time": "20:00",
    "weekdays": [6,7],
    "action": "playlist_dir",
    "dir": "music/rock"
  },
  {
    "name": "深夜转播 Nightwave",
    "time": "23:00",
    "action": "relay",
    "url": "https://plaza.one/mp3",
    "name": "Nightwave Plaza"
  }
]

后台线程每 30 秒检查，到点（HH:MM 匹配 + 星期匹配 + 当分钟未触发过）执行动作。
_last_fired 防同分钟重复触发；1 小时后清理。
"""
import json
import os
import threading
import time
import datetime

_PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEDULE_PATH = os.path.join(_PROJECT_DIR, "schedule.json")

_lock = threading.Lock()
_thread = None
_stop = False
_last_fired = {}        # key("name-YYYYMMDDHHMM") -> datetime，防重复触发
_enabled = True         # 总开关


def load_schedule():
    """读取 schedule.json（每次请求都读，改完刷新生效）。格式错返回 []。"""
    try:
        with open(SCHEDULE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            return []
        return [i for i in data if isinstance(i, dict) and i.get("time") and i.get("action")]
    except Exception:
        return []


def save_schedule(items):
    """原子写 schedule.json。"""
    tmp = SCHEDULE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SCHEDULE_PATH)


def is_enabled():
    return _enabled


def set_enabled(v):
    global _enabled
    with _lock:
        _enabled = bool(v)


def _match_now(item, now):
    """item 是否匹配当前时间。now: datetime。weekdays 用 isoweekday（1=周一...7=周日）。"""
    t = item.get("time", "")
    try:
        hh, mm = t.split(":")
        hh, mm = int(hh), int(mm)
    except Exception:
        return False
    if now.hour != hh or now.minute != mm:
        return False
    wd = item.get("weekdays")
    if wd:
        try:
            if now.isoweekday() not in [int(w) for w in wd]:
                return False
        except Exception:
            return False
    return True


def _execute(station, item):
    """执行排程动作。"""
    action = item.get("action")
    name = item.get("name", action)
    try:
        if action == "playlist_dir":
            d = item.get("dir", "")
            if d:
                # 支持相对项目根的路径
                if not os.path.isabs(d):
                    d = os.path.join(_PROJECT_DIR, d)
                station.set_playlist_dir(d)
        elif action == "relay":
            url = item.get("url", "")
            if url:
                station.set_relay(url, item.get("name"))
        elif action == "shuffle":
            station.toggle_shuffle()
        elif action == "stop_relay":
            station.stop_relay()
        else:
            return
        # 记录到播放历史
        station.set_title(f"[节目单] {name}")
        station.record_history(station.current_title)
    except Exception:
        pass


def _run(station):
    while not _stop:
        if _enabled:
            try:
                now = datetime.datetime.now()
                for item in load_schedule():
                    if not _match_now(item, now):
                        continue
                    key = f"{item.get('name','')}-{now.strftime('%Y%m%d%H%M')}"
                    with _lock:
                        if key in _last_fired:
                            continue
                        _last_fired[key] = now
                    _execute(station, item)
                # 清理 1 小时前的触发记录
                cutoff = datetime.datetime.now() - datetime.timedelta(hours=1)
                with _lock:
                    for k in list(_last_fired):
                        if _last_fired[k] < cutoff:
                            del _last_fired[k]
            except Exception:
                pass
        time.sleep(30)


def start(station):
    global _thread, _stop
    if _thread and _thread.is_alive():
        return False
    _stop = False
    _thread = threading.Thread(target=_run, args=(station,), daemon=True, name="schedule")
    _thread.start()
    return True


def stop():
    global _stop
    _stop = True


def upcoming(station, n=5):
    """返回接下来 n 条即将触发的排程（供面板显示）。"""
    if not _enabled:
        return []
    items = load_schedule()
    now = datetime.datetime.now()
    upcoming_list = []
    # 检查未来 7 天每分钟
    for offset in range(0, 7 * 24 * 60, 1):
        t = now + datetime.timedelta(minutes=offset)
        for item in items:
            if _match_now(item, t):
                upcoming_list.append({
                    "name": item.get("name", item.get("action")),
                    "time": item.get("time"),
                    "action": item.get("action"),
                    "dir": item.get("dir"),
                    "url": item.get("url"),
                    "weekdays": item.get("weekdays"),
                    "fires_in_min": offset,
                    "fires_at": t.strftime("%Y-%m-%d %H:%M"),
                })
                if len(upcoming_list) >= n:
                    return upcoming_list
                break
    return upcoming_list
