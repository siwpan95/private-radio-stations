# 获取战旗直播（战旗TV）的真实流媒体地址。https://www.zhanqi.tv/
# 默认最高画质
# 更新记录：
#   2026-08-28 规则修复：旧 v2.1 domain API 已废（返回系统错误页）；
#   改从房间页 HTML 直接提取 videoId/status（页面内嵌房间 JSON），
#   后续 viewer/chain/CDN 链路实测仍可用，保持不变。

import json
import re

import requests


class ZhanQi:

    def __init__(self, rid):
        """
        支持：裸房间号（如 196525）/ 房间链接（https://www.zhanqi.tv/196525）/ 主题直播间链接
        从房间页 HTML 内嵌 JSON 提取 videoId 与 status。
        """
        self.s = requests.Session()
        url = rid if str(rid).startswith('http') else f'https://www.zhanqi.tv/{rid}'
        res = self.s.get(url, timeout=15).text
        m_vid = re.search(r'"videoId":"([^"]+)"', res)
        m_st = re.search(r'"status":"(\d)"', res)
        if not m_vid or not m_st:
            raise Exception('Incorrect rid')
        self.videoid = m_vid.group(1)
        self.status = m_st.group(1)

    def get_real_url(self):
        if self.status != '4':
            raise Exception('No streaming')

        # 获取 gid
        res = self.s.get('https://www.zhanqi.tv/api/public/room.viewer', timeout=10)
        try:
            res = res.json()
            gid = res['data']['gid']
        except (KeyError, json.decoder.JSONDecodeError):
            raise Exception('Getting gid incorrectly')

        # 获取 cdn_host
        res = self.s.get('https://umc.danuoyi.alicdn.com/dns_resolve_https?app=zqlive&host_key=alhdl-cdn.zhanqi.tv',
                         timeout=10)
        cdn_host, *_ = res.json().get('redirect_domain')

        # 获取 chain_key
        data = {
            'stream': f'{self.videoid}.flv',
            'cdnKey': 202,
            'platform': 128,
        }
        headers = {
            'cookie': f'gid={gid}',
        }
        res = self.s.post('https://www.zhanqi.tv/api/public/burglar/chain', data=data,
                          headers=headers, timeout=10).json()
        chain_key = res['data']['key']
        url = f'https://{cdn_host}/alhdl-cdn.zhanqi.tv/zqlive/{self.videoid}.flv?{chain_key}&playNum=68072487067' \
              f'&gId={gid}&ipFrom=1&clientIp=&fhost=h5&platform=128'
        return url


def get_real_url(rid):
    try:
        zq = ZhanQi(rid)
        return zq.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    # 直播间链接类似：https://www.zhanqi.tv/196525
    r = input('输入战旗直播间的链接或房间号：\n')
    print(get_real_url(r))
