# 获取龙珠直播的真实流媒体地址，默认最高画质。
# 更新记录：
#   2026-08-28 规则修复：旧 .com 域名（star/livestream.longzhu.com）已废；
#   现行站点为 https://www.longzhu.cn/v2/（Vue SPA，后端 lzapi.kuaiqiuzhibo.com），
#   改为 room-biz/room/detail → pullStreamData.lhd 直链（flvUrl/m3u8Url）。

import re

import requests


class LongZhu:

    API = 'https://lzapi.kuaiqiuzhibo.com/room-biz'

    def __init__(self, rid):
        """支持：裸房间号（如 9878）/ 直播间链接（www.longzhu.cn/v2/live/{id}）"""
        rid = str(rid or '').strip()
        m = re.search(r'/(?:v2/)?live/(\d+)', rid)
        self.rid = m.group(1) if m else rid
        if not self.rid.isdigit():
            raise Exception('Incorrect rid')

    def get_real_url(self):
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'client': 'web_pc',
            'channel': 'web',
            'product': 'lzLive',
            'version': '1.0.0',
        }
        res = requests.get(f'{self.API}/room/detail', headers=headers,
                           params={'roomId': self.rid}, timeout=15).json()
        data = res.get('data') or {}
        live = data.get('liveData') or {}
        if live.get('liveStatus') != 1:
            raise Exception('直播间不存在或未开播')
        ps = data.get('pullStreamData') or {}
        # 默认最高画质：优先 lhd，回退 lld
        for key in ('lhd', 'lld'):
            st = ps.get(key) or {}
            url = st.get('flvUrl') or st.get('m3u8Url')
            if url:
                return url
        raise Exception('No streaming')


def get_real_url(rid):
    try:
        lz = LongZhu(rid)
        return lz.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    # 直播间号类似：9878
    r = input('输入龙珠直播间号或链接：\n')
    print(get_real_url(r))
