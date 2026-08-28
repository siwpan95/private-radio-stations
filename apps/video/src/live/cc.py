# 获取网易CC的真实流媒体地址。
# 默认为最高画质
# 更新记录：
#   2026-08-28 规则修复：旧链路 anchor/lives → channelids → sharefile 已失效
#   （anchor/lives 现只返回 is_black，channelids 页无流数据）；
#   改为解析主页 cc.163.com SSR 内嵌的「正在直播」房间列表 JSON
#   （{"room_id":X,...,"m3u8":"http://cgi.v.cc.163.com/redirect/..."}），
#   m3u8 直链 302 到真实 HLS（实测可播）。局限：仅覆盖首页直播列表内的房间。

import re

import requests


class CC:

    def __init__(self, rid):
        self.rid = str(rid or '').strip()

    def get_real_url(self):
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        }
        res = requests.get('https://cc.163.com/', headers=headers, timeout=15).text
        m = re.search(r'"room_id"\s*:\s*' + re.escape(self.rid) +
                      r'[^}]*?"m3u8"\s*:\s*"([^"]+)"', res)
        if not m:
            raise Exception('直播间不存在或未开播（或不在首页直播列表）')
        return m.group(1)


def get_real_url(rid):
    try:
        cc = CC(rid)
        return cc.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    # 直播间号类似：520
    r = input('输入网易CC直播间号：\n')
    print(get_real_url(r))
