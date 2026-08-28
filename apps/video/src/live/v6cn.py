# 获取六间房直播的真实流媒体地址。
#
# 2026-08 修复说明（现行移动端播放器 v2 的 makeStreamingUrl 逻辑，两路均实测 200）：
#   1. 房间页 https://v.6.cn/{rid} 内联数据取 flvtitle（形如 v{uid}-{sid}，开播房间必有）。
#   2. 拉流节点查询 https://oir.6rooms.com/live/?s={uid}（rio.6rooms.com 同源兜底），
#      取 XML 里的 <hip>（当前为 wlive.6rooms.com，按房间动态下发节点池）。
#   3. 流地址（无鉴权参数、免登录）：
#      - HLS：https://{hip}/liverecord/{flvtitle}/playlist.m3u8
#      - FLV：https://{hip}/liverecord/{flvtitle}.flv（直出 video/x-flv，最稳）
#   另：播放器实际发起的带参地址 {hip}/httpflv/{flvtitle}.flv?os=9&page=room&ruid={uid}
#   （Playwright 无头抓包确认）同样有效，但 liverecord 免参数更简洁，故采用后者。

import requests
import re

DEFAULT_HIP = 'wlive.6rooms.com'


class V6CN:

    def __init__(self, rid):
        self.rid = rid

    def _get_hip(self, uid):
        """拉流节点：oir 优先，rio 兜底，均失败用默认节点。"""
        for host in ('oir.6rooms.com', 'rio.6rooms.com'):
            try:
                r = requests.get(f'https://{host}/live/?s={uid}', timeout=10)
                m = re.search(r'<hip>([^<]+)</hip>', r.text)
                if m and m.group(1):
                    return m.group(1)
            except Exception:
                continue
        return DEFAULT_HIP

    def get_real_url(self):
        try:
            response = requests.get(f'https://v.6.cn/{self.rid}', timeout=15).text
            result = re.findall(r'flvtitle["\'\s]*[:=]\s*["\'](v\d+-\d+)', response)
            if not result:
                raise Exception('无 flvtitle')
            flvtitle = result[0]
            uid = flvtitle.split('-')[0][1:]  # v{uid}-{sid} -> uid
            hip = self._get_hip(uid)
            real_url = [f'https://{hip}/liverecord/{flvtitle}/playlist.m3u8',
                        f'https://{hip}/liverecord/{flvtitle}.flv']
        except Exception:
            raise Exception('直播间不存在或未开播')
        return real_url


def get_real_url(rid):
    try:
        v6cn = V6CN(rid)
        return v6cn.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    r = input('请输入六间房直播房间号：\n')
    print(get_real_url(r))
