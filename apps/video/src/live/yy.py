# 获取YY直播的真实流媒体地址。https://www.yy.com/1349606469
# 默认获取最高画质（HLS/m3u8）
#
# 2026-08 修复说明（两条路径均实测可用）：
#   主路径 stream-manager —— 现行 PC 播放器（yycom_live 主包）使用的 Thunder 流系统
#   协议，免签名免登录：
#     POST https://stream-manager.yy.com/v3/channel/streams
#       ?uid=0&cid={rid}&sid={rid}&appid=0&sequence={毫秒时间戳}&encode=json
#     JSON body 三部分：head / client_attribute / avp_parameter
#       （gear=4 最高档；stream_format=1=m3u8，0=flv）
#     响应 avp_info_res.stream_line_addr.{appid}_xv_{rid}_*.cdn_info.url 即真实流地址；
#     未开播/不存在时 stream_line_addr 为空（仅 BCGroup 流）。
#   备用路径 wap interface（旧移动端接口，仍存活）：
#     GET https://interface.yy.com/hls/new/get/{rid}/{rid}/1200?source=wapyy&callback=
#     开播房间直接在响应的 hls 字段返回完整 m3u8；未开播时 video/audio 为空。
#   两条路径产出的 m3u8（sslproxy.yy.com:4443）均实测 200 + #EXTM3U；直链含
#   t/tk 时效签名（分钟级），必须即时使用，不可长期缓存。

import json
import re
import time

import requests

_USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
               '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')


class YY:

    def __init__(self, rid):
        self.rid = str(rid)

    def _via_stream_manager(self):
        """现行 PC 播放器官方协议：POST stream-manager 取 cdn_info.url。"""
        ms = int(time.time() * 1000)
        url = ('https://stream-manager.yy.com/v3/channel/streams'
               f'?uid=0&cid={self.rid}&sid={self.rid}&appid=0&sequence={ms}&encode=json')
        body = {
            'head': {
                'seq': ms, 'appidstr': '0', 'bidstr': '121',
                'cidstr': self.rid, 'sidstr': self.rid, 'uid64': 0,
                'client_type': 108, 'client_ver': '0', 'stream_sys_ver': 1,
                'app': 'yylive_web', 'playersdk_ver': '5.23.0-beta.2',
                'thundersdk_ver': '0', 'streamsdk_ver': '5.23.0-beta.2',
            },
            'client_attribute': {
                'client': 'web', 'os': 'chrome', 'client_type': 8, 'h265': 0,
                'platform': 'pc', 'version': '5.23.0-beta.2',
            },
            'avp_parameter': {
                'version': 1, 'client_type': 8, 'send_time': int(time.time()),
                'line_seq': -1, 'gear': 4, 'ssl': 1, 'stream_format': 1,
                'ext_param': None,
            },
        }
        headers = {'User-Agent': _USER_AGENT, 'Referer': 'https://www.yy.com/',
                   'Content-Type': 'application/json'}
        res = requests.post(url, json=body, headers=headers, timeout=15)
        if res.status_code != 200:
            raise Exception('stream-manager 请求失败')
        data = res.json()
        avp = data.get('avp_info_res') or {}
        for _key, line in (avp.get('stream_line_addr') or {}).items():
            url = (line.get('cdn_info') or {}).get('url')
            if url:
                return url
        raise Exception('未开播或直播间不存在')

    def _via_wap_interface(self):
        """备用：旧 wap 移动端接口，开播房间直返 hls 字段。"""
        headers = {'referer': f'https://wap.yy.com/mobileweb/{self.rid}',
                   'user-agent': _USER_AGENT}
        room_url = (f'https://interface.yy.com/hls/new/get/{self.rid}/{self.rid}/1200'
                    f'?source=wapyy&callback=')
        res = requests.get(room_url, headers=headers, timeout=15)
        if res.status_code != 200:
            raise Exception('直播间不存在')
        m = re.search(r'\{.*\}', res.text, re.S)
        if not m:
            raise Exception('响应格式异常')
        data = json.loads(m.group(0))
        hls = data.get('hls')
        if hls:
            return hls
        if data.get('video'):
            raise Exception('未获取到 hls 地址')
        raise Exception('未开播或直播间不存在')

    def get_real_url(self):
        try:
            return self._via_stream_manager()
        except Exception:
            return self._via_wap_interface()


def get_real_url(rid):
    try:
        yy = YY(rid)
        return yy.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    r = input('输入YY直播房间号：\n')
    print(get_real_url(r))
