# -*- coding: utf-8 -*-
# 抖音直播真实流地址（2026-08 逆向，现行 live.douyin.com 网页版）
#
# 旧接口 webcast.amemv.com/webcast/room/reflow/info/（app_id=1128）已 404 下线。
#
# 现行取流方式（实测 2026-08-28 可用，免签名）：
#   抖音直播房间页 live.douyin.com/<web_rid> 的服务端渲染(SSR) HTML 里，
#   直接内嵌了直播流地址（roomStore.roomInfo 里的 web_stream_url，以及
#   flv_pull_url / hls_pull_url_map 里的各清晰度地址）。地址形如：
#     http://pull-flv-<节点>.douyinliving.com/<bucket>/stream-<流id>[_清晰度].flv?expire=<ts>&sign=<签名>&...
#     http://pull-hls-<节点>.douyinliving.com/<bucket>/stream-<流id>[_清晰度].m3u8?expire=<ts>&sign=<签名>&...
#   <bucket> 游戏房是 thirdgame，秀场/户外等是 stage（本模块按通用正则抓取，不依赖 bucket）。
#   清晰度后缀：_origin(原画) > _xuhd5(极限超清) > _hiquhd5/_uhd(超清) > _or4 >
#               _hiqhd5/_hd(高清) > _hiqsd5/_sd(标清) > _hiqld5/_ld(流畅) > _md。
#   该地址带 expire/sign，有一定时效，故每次调用都重新抓页面取新鲜地址。
#
# 相比需要 a_bogus 签名的 webcast/room/web/enter/ 接口，SSR 页面方案无需
# cookie、无需签名，更稳定。web/enter 仍可用作备选（需 ttwid cookie +
# a_bogus 签名），但本模块不依赖它。
#
# 契约：get_real_url(rid) -> 流地址字符串；失败抛异常（resolve.py 捕获后输出 ok:false）。
# 输入：live.douyin.com/<web_rid> 短号、或分享链接（v.douyin.com / live.douyin.com / www.douyin.com）。
#   注意：旧契约的「19 位 room_id」是 app_id=1128 时代的内部长 id，现行网页版
#   只认 web_rid 短号，19 位长 id 已无法直接解析（live.douyin.com/<19位> 返回无效页）。

import re

import requests

_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)

# 清晰度优先级（高 -> 低），无后缀表示主路原画
_QUALITY_PRIORITY = [
    '_origin',    # 原画
    '',           # 主路（无后缀，原画）
    '_xuhd5',     # 极限超清
    '_hiquhd5',   # 超清(hiq)
    '_uhd',       # 超清
    '_or4',       # 原画(or4)
    '_hiqhd5',    # 高清(hiq)
    '_hd',        # 高清
    '_hiqsd5',    # 标清(hiq)
    '_sd',        # 标清
    '_hiqld5',    # 流畅(hiq)
    '_ld',        # 流畅
    '_md',        # 中
]
_PRIORITY_MAP = {q: i for i, q in enumerate(_QUALITY_PRIORITY)}


def _normalize_rid(rid):
    """把分享链接 / web_rid 归一化为网页版 web_rid（短号）。纯数字直接透传。"""
    rid = (rid or '').strip()
    if not rid:
        raise ValueError('抖音：房间号为空')
    # 分享链接里显式的房间参数（room_id / roomId / web_rid / webId）
    if '?' in rid:
        for kv in rid.split('?', 1)[1].split('&'):
            if kv.startswith(('room_id=', 'roomId=', 'web_rid=', 'webId=')):
                val = kv.split('=', 1)[1].split('#')[0].split('&')[0]
                if val:
                    return val
    # douyin.com 链接：取路径最后一段
    if 'douyin.com/' in rid:
        remainder = rid.split('douyin.com/', 1)[1]
        path = remainder.split('?')[0].split('#')[0]
        seg = [s for s in path.split('/') if s]
        if seg:
            return seg[-1].split('&')[0]
    # 纯数字直接返回（web_rid 短号 / 19 位 room_id 均可）
    return rid


def _clean_url(u):
    """清理 HTML 里抓出来的流地址（还原 \\uXXXX 转义、去掉结尾反斜杠）。"""
    u = u.rstrip('\\').strip()
    # SSR 内嵌 JSON 里 & / = 等被转义成 \u0026 \u002F \u003D ...，统一还原
    u = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), u)
    u = u.replace('\\/', '/').replace('&amp;', '&')
    return u


def _quality_of(url):
    """从 stream-<id>[_清晰度].flv/.m3u8 中提取清晰度后缀。"""
    m = re.search(r'stream-\d+(_[a-z0-9]+)?\.(?:flv|m3u8)', url)
    return m.group(1) if m and m.group(1) else ''


def _pick_best(streams):
    """在若干流地址里挑画质最高者：优先 flv 原画，其次 hls。"""
    flvs = [s for s in streams if '.flv' in s]
    m3u8s = [s for s in streams if '.m3u8' in s]

    def sort_key(u):
        q = _quality_of(u)
        prio = _PRIORITY_MAP.get(q, 99)
        # 同画质下 https 优先
        https = 0 if u.startswith('https://') else 1
        return (prio, https, u)

    if flvs:
        return min(flvs, key=sort_key)
    if m3u8s:
        return min(m3u8s, key=sort_key)
    return None


def _extract_streams(html):
    """从房间页 HTML 里抓取全部直播流地址（flv / m3u8）。"""
    urls = re.findall(r'https?://[^"\s]+', html)
    streams = []
    for u in urls:
        if 'stream-' not in u:
            continue
        if '.flv' not in u and '.m3u8' not in u:
            continue
        u = _clean_url(u)
        if not u.startswith(('http://', 'https://')):
            continue
        # 过滤纯音频流与 H.265 低延迟流（DTV 同款过滤），只保留可播放的视频流
        if 'only_audio=1' in u:
            continue
        if 'pull-hs' in u:
            continue
        streams.append(u)
    # 去重但保持顺序
    seen = set()
    out = []
    for s in streams:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _extract_status(html):
    """从 SSR 的房间对象里读 status（2=直播中，其余=未开播/结束）。

    SSR 里房间对象形如 `\"status\":2,\"status_str\"`（引号可能带反斜杠转义）。
    """
    m = re.search(r'status\\?":(\d+),\\?"status_str', html)
    if m:
        return int(m.group(1))
    return None


def get_real_url(url):
    """获取抖音直播真实流地址。

    返回 http(s) 流地址；未开播或解析失败抛异常（resolve.py 捕获后输出 ok:false）。
    """
    web_rid = _normalize_rid(url)

    session = requests.Session()
    session.headers['User-Agent'] = _USER_AGENT
    session.headers['Referer'] = 'https://live.douyin.com/%s' % web_rid

    resp = session.get('https://live.douyin.com/%s' % web_rid, timeout=15)
    resp.raise_for_status()
    html = resp.text

    streams = _extract_streams(html)
    if streams:
        return _pick_best(streams)

    # 没有抓到流地址：区分「未开播」与「开播但解析失败」
    status = _extract_status(html)
    if status is not None and status != 2:
        raise RuntimeError('抖音：房间未开播（status=%s，仅直播中 status=2 才有流）' % status)
    if status == 2:
        raise RuntimeError('抖音：房间直播中但页面未找到流地址（可能规则变动）')
    raise RuntimeError('抖音：未获取到播放地址（未开播或规则失效）')


if __name__ == '__main__':
    import sys
    rid = sys.argv[1] if len(sys.argv) > 1 else input('请输入抖音直播间号或链接：\n')
    print(get_real_url(rid))
