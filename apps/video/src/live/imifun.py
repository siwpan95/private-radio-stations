# 艾米直播：https://www.imifun.com/（现站入口 happyia.com:7001 亦跳转至此）
# 更新记录：
#   2026-08-28 规则修复：旧 wsmd.happyia.com 播放域已死；
#   改为解析房间页内嵌 JS 变量 newPlayUrl（rtmp 混流直链）。

import re

import requests


class IMFun:

    def __init__(self, rid):
        self.rid = str(rid or '').strip()

    def get_real_url(self):
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        }
        res = requests.get(f'https://www.imifun.com/{self.rid}', headers=headers, timeout=15).text
        m = re.search(r'var newPlayUrl\s*=\s*"([^"]+)"', res)
        if not m or not m.group(1):
            raise Exception('直播间不存在或未开播')
        return m.group(1)


def get_real_url(rid):
    try:
        imf = IMFun(rid)
        return imf.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    r = input('输入艾米直播间号：\n')
    print(get_real_url(r))
