# KK直播：http://www.kktv5.com/
# 更新记录：
#   2026-08-28 规则修复：旧 sapi.kktv1.com/meShow/entrance 端点已死；
#   改为解析主页 SSR 内嵌 recommendRoomList（roomId ↔ liveStream flv 直链）。
#   局限：仅覆盖首页推荐列表内房间。

import re

import requests


class KK:

    def __init__(self, rid):
        """
        KK直播
        Args:
            rid: 直播间号
        """
        self.rid = str(rid or '').strip()

    def get_real_url(self):
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        }
        res = requests.get('https://www.kktv5.com/', headers=headers, timeout=15).text
        m = re.search(r'"roomId"\s*:\s*' + re.escape(self.rid) +
                      r'[^}]*?"liveStream"\s*:\s*"([^"]+)"', res)
        if not m:
            raise Exception('直播间不存在或未开播（或不在首页推荐列表）')
        return m.group(1)


def get_real_url(rid):
    try:
        kk = KK(rid)
        return kk.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    r = input('输入KK直播间号：\n')
    print(get_real_url(r))
