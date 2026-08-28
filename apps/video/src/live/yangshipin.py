# -*- coding: utf-8 -*-
# 央视频 / 央视网 直播流解析（2026-08 逆向更新）
#
# 现行取流两条路线：
#   A. 央视频路线 liveinfo.yangshipin.cn txvlive：encryptVer 仍为 8.1，
#      现行 ysplayer（@tencent/cctvfe-player）appVer=1.44.1，ckey 的 wu 串
#      格式为 |vid|ts|mg3c3b04ba|ver|guid|platform|url|ua|referrer|Mozilla|
#      Netscape|Win32|（AES key/iv 未变）。已用 Node shim 执行 ysplayer 的
#      Ut 混淆函数逐字节对照：key/iv/hash/wu 格式完全一致，即本文件 _make_ckey
#      为现行算法的忠实复刻。央视频道（CCTV1 等）现已上登录墙
#      （iretcode 25 / 无登录信息），该路线对免费频道仍可用。
#   B. 央视网路线 vdnx.live.cntv.cn /api/v3/vdn/live：请求需带 auth-key 头，
#      auth-key = "{hbss}-{rn}-{md5(channel+hbss+rn+secret)}"（secret 为
#      PC 端公开静态串）。返回 hls_cdrm 为清晰 HLS（H264+AAC，实测无加密），
#      且无需登录，是央视频道现行最稳的取流方式。
#
# 频道名解析：输入 pid 可能是"频道id"（12 位，如 180333736434），需先经
#   m.yangshipin.cn 的 meta-refresh 解析出真实 pid（600001859），再用
#   h5_live_poll 拿频道标题（CCTV1），映射成央视网频道名（cctv1）。

import binascii
import ctypes
import hashlib
import random
import re
import time
import uuid
from urllib.parse import parse_qs, urlencode

import requests
from Crypto.Cipher import AES

# --- 常量（客户端 JS 内公开的静态值） ---
CKEY_KEY = '4E2918885FD98109869D14E0231A0BF4'   # AES-128-CBC key（与旧版一致）
CKEY_IV = '16B17E519DDD0CE5B79D7A63A4DD801C'    # AES-128-CBC iv（与旧版一致）
CKEY_JC = 'mg3c3b04ba'
CKEY_PREFIX = '--01'
TXV_VERSION = '1.44.1'                           # ysplayer 版本（@tencent/cctvfe-player）
GUID = 'ko7djb70_vbjvrg5gcm'
PLATFORM = 4330701
VDNX_SECRET = 'a4220a71b31746908fa3e7fdd7a6852a'  # vdnx auth-key 的 PC 端密钥
VAPPID = '59306155'
VSECRET = 'b42702bf7309a179d102f3d51b1add2fda0bc7ada64cb801'

MOBILE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) '
             'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 '
             'Mobile/15E148 Safari/604.1')
PC_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')

# 央视频频道标题 -> 央视网频道名（特殊频道手动映射）
CNTV_CHANNEL_MAP = {
    'cctv5+': 'cctv5plus',
    'cctv9': 'cctvjilu',      # CCTV-9 纪录
    'cctv14': 'cctvchild',    # CCTV-14 少儿
    'cctv4欧洲': 'cctveurope',
    'cctv4美洲': 'cctvamerica',
}


def _hash_wu(wu):
    """time33 变体哈希，返回 int32（与播放器 JS 一致）"""
    u = 0
    for ch in wu:
        u = (u << 5) - u + ord(ch)
        u &= u & 0xffffffff
    return ctypes.c_int32(u).value


def _aes_encrypt(text):
    """AES-128-CBC + PKCS7 填充"""
    key = binascii.a2b_hex(CKEY_KEY)
    iv = binascii.a2b_hex(CKEY_IV)
    pad = 16 - len(text) % 16
    text = text + pad * chr(pad)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    return binascii.b2a_hex(cipher.encrypt(text.encode())).decode()


def _make_ckey(vid, ts):
    """生成 ckey（现行 encryptVer 8.1 算法）"""
    wu = (f'|{vid}|{ts}|{CKEY_JC}|{TXV_VERSION}|{GUID}|{PLATFORM}'
          f'|https://m.yangshipin.cn/'
          f'|mozilla/5.0 (iphone; cpu|https://m.yangshipin.cn/'
          f'|Mozilla|Netscape|Win32|')
    bu = _hash_wu(wu)
    xu = f'|{bu}{wu}'
    return (CKEY_PREFIX + _aes_encrypt(xu)).upper()


def _resolve_pid(vid, pid):
    """频道id -> 真实 pid（m.yangshipin.cn 服务端 meta-refresh 解析）"""
    url = f'https://m.yangshipin.cn/tv?vid={vid}&pid={pid}'
    try:
        r = requests.get(url, headers={'User-Agent': MOBILE_UA},
                         timeout=15, allow_redirects=False)
        m = re.search(r"URL='([^']+)'", r.text)
        if not m or '?' not in m.group(1):
            return pid
        qs = parse_qs(m.group(1).split('?', 1)[1])
        return qs.get('pid', [pid])[0]
    except Exception:
        return pid


def _get_channel_title(vid, pid):
    """h5_live_poll 取频道标题（如 CCTV1）"""
    params = {
        'vappid': VAPPID, 'vsecret': VSECRET, 'raw': '1',
        'pid': pid, 'reqType': '2', 'streamID': vid, 'channelID': '',
    }
    url = 'https://h5access.yangshipin.cn/web/h5_live_poll?' + urlencode(params)
    r = requests.get(url, headers={'User-Agent': MOBILE_UA}, timeout=15)
    j = r.json()
    return (j.get('data', {}).get('h5TVLivePollRsp', {})
            .get('tvLivePollRsp', {}).get('title', '') or '')


def _title_to_channel(title):
    """央视频标题 -> 央视网频道名；非央视频道返回 None"""
    t = (title or '').strip().lower()
    if not t:
        return None
    if t in CNTV_CHANNEL_MAP:
        return CNTV_CHANNEL_MAP[t]
    if t.startswith('cctv'):
        return t
    return None


def _vdnx_route(channel):
    """央视网路线：vdnx.live.cntv.cn，带 auth-key 头，返回清晰 m3u8"""
    # 端点偶发 ack:no，重试 3 次提高成功率
    for _ in range(3):
        hbss = int(time.time() * 1000)
        rn = random.randint(100, 1099)
        h = hashlib.md5(f'{channel}{hbss}{rn}{VDNX_SECRET}'.encode()).hexdigest().lower()
        auth_key = f'{hbss}-{rn}-{h}'
        url = (f'https://vdnx.live.cntv.cn/api/v3/vdn/live'
               f'?channel={channel}&vn=1&pdrm=1&uid=&hbss={hbss}')
        headers = {'User-Agent': PC_UA, 'Referer': 'https://tv.cctv.com/',
                   'auth-key': auth_key}
        try:
            r = requests.get(url, headers=headers, timeout=15)
            j = r.json()
        except Exception:
            continue
        if j.get('ack') != 'yes':
            continue
        manifest = j.get('manifest', {})
        backup = j.get('backup', {})
        url = manifest.get('hls_cdrm') or backup.get('hls_cdrm')
        if url:
            return url
    return None


def _yangshipin_route(vid, pid):
    """央视频路线：liveinfo.yangshipin.cn txvlive（ckey 已修，两段式）

    现行 ysplayer 精简参数集；首请求用本地时间戳，若 iretcode==32（时间不同步）
    用响应 svrtick 重算 cKey 重试。端点选择：6 位 pid 走 liveinfo-test，
    重试超限切 bkliveinfo。
    """
    headers = {'User-Agent': MOBILE_UA, 'Referer': 'https://m.yangshipin.cn/'}

    def _request(ts):
        ckey = _make_ckey(vid, ts)
        params = {
            'defn': '', 'flowid': uuid.uuid4().hex, 'platform': PLATFORM,
            'cmd': 2, 'appVer': TXV_VERSION, 'encryptVer': '8.1',
            'vip_status': 1, 'livequeue': 1, 'sphttps': 1, 'cnlid': vid,
            'livepid': pid, 'system': 1, 'sdtfrom': 113, 'cKey': ckey,
            'host': 'yangshipin.cn',
        }
        host = ('liveinfo-test.yangshipin.cn' if len(str(pid)) == 6
                else 'liveinfo.yangshipin.cn')
        r = requests.get(f'https://{host}/', headers=headers, params=params,
                         timeout=15)
        return r.json()

    j = _request(int(time.time()))
    # 时间不同步 → 用服务器 svrtick 重算 cKey 重试
    if j.get('iretcode') == 32 and j.get('svrtick'):
        j = _request(j['svrtick'])
    return j.get('playurl') or None


def get_real_url(rid):
    try:
        var = parse_qs(rid)
        vid = var['vid'][0]
        pid = var['pid'][0]
    except (KeyError, IndexError, ValueError):
        return False

    # 输入校验：vid/pid 必须是数字串，否则视为非法输入
    if not (vid and pid and vid.isdigit() and pid.isdigit()):
        return False

    try:
        # 解析真实 pid（频道id -> pid）与频道标题
        real_pid = _resolve_pid(vid, pid)
        title = _get_channel_title(vid, real_pid)

        # 路线1：央视频道走 tv.cctv（无登录墙，清晰流）
        channel = _title_to_channel(title)
        if channel:
            url = _vdnx_route(channel)
            if url:
                return url

        # 路线2：央视频 ckey（修复后，供免费/非央视频道）
        url = _yangshipin_route(vid, real_pid)
        if url:
            return url
    except Exception as e:
        print('Exception：', e)
    return False


if __name__ == '__main__':
    r = input('显示“无登录信息”，则需要填充cookie。请输入央视频地址：\n')
    print(get_real_url(r))
