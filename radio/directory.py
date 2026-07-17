"""Radio-Browser.info 全球电台目录（免费、社区维护，约 3 万+ 电台）。

用来在我们的控制面板里搜索真实电台，然后转播（relay）过来。
接口文档：https://api.radio-browser.info/
注意：官方要求带上可识别的 User-Agent。
"""
import requests

# 多个镜像，按顺序尝试，提高可用性
_BASES = [
    "https://de1.api.radio-browser.info/json",
    "https://nl1.api.radio-browser.info/json",
    "https://at1.api.radio-browser.info/json",
]
_UA = {"User-Agent": "MyPythonRadio/1.0 (github.com/yourname)"}


def search(query, limit=20):
    """按关键词搜索电台，返回精简列表；任何异常都返回 []（不阻断主程序）。"""
    if not query:
        return []
    params = {
        "name": query,
        "limit": limit,
        "hidebroken": "true",     # 过滤掉连不上的
        "order": "votes",         # 按投票数排序，质量更高
        "reverse": "true",
    }
    for base in _BASES:
        try:
            r = requests.get(
                f"{base}/stations/search",
                params=params, headers=_UA, timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            break
        except Exception:
            data = None
            continue
    if not data:
        return []

    out = []
    for s in data:
        out.append({
            "name": (s.get("name") or "").strip() or "(无名电台)",
            "url": s.get("url_resolved") or s.get("url", ""),
            "bitrate": s.get("bitrate", 0) or 0,
            "codec": (s.get("codec") or "").upper(),
            "country": s.get("country", "") or "",
            "tags": (s.get("tags") or "").replace(",", " ")[:60],
            "favicon": s.get("favicon", "") or "",
        })
    return out
