# 获取快手直播的真实流媒体地址，默认输出最高画质
# 支持输入：房间号（如 KPL704668133）/ live.kuaishou.com/u/{id} 链接 / v.kuaishou.com 短链（自动跟随）
# 原理：live.kuaishou.com SSR 页面内嵌 playList JSON
#       （liveStream.playUrls.h264.adaptationSet.representation[]，各档位含签名直链），取最高码率档。
# 更新记录：
#   2026-08-28 旧规则失效修复：m.gifshow.com/fw/live 端点已换代（SSR 壳不含 liveStream），
#   改为解析 live.kuaishou.com/u/{id} 页面内嵌 playList；输入增加 URL 归一化。

import json
import re
from urllib.parse import urlparse

import requests


class KuaiShou:

    def __init__(self, rid):
        self.rid = self._normalize_rid(rid)

    @staticmethod
    def _normalize_rid(rid):
        """归一化输入：短链跟随重定向；live.kuaishou.com/u/{id} 提取 id；裸房间号原样"""
        rid = str(rid or '').strip()
        if rid.startswith('http'):
            host = urlparse(rid).netloc
            if 'kuaishou.com' not in host:
                # 分享短链（v.kuaishou.com / kwai 系）：跟随一次拿最终地址
                try:
                    with requests.Session() as s:
                        r = s.head(rid, allow_redirects=True, timeout=10)
                        rid = r.url
                except Exception:
                    try:
                        with requests.Session() as s:
                            r = s.get(rid, allow_redirects=True, timeout=15, stream=True)
                            rid = r.url
                            r.close()
                    except Exception:
                        pass
            m = re.search(r'live\.kuaishou\.com/(?:u|profile)/([A-Za-z0-9_-]+)', rid)
            if m:
                return m.group(1)
            # 兜底：取路径最后一段（若仍无法解析，后续请求会报未开播）
            return urlparse(rid).path.strip('/').split('/')[-1]
        return rid

    def get_real_url(self):
        headers = {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'accept-language': 'zh-CN,zh;q=0.9',
            'cookie': 'did=web_d563dca728d28b00336877723e0359ed',
        }
        with requests.Session() as s:
            res = s.get('https://live.kuaishou.com/u/{}'.format(self.rid),
                        headers=headers, timeout=15)
            m = re.search(r'"representation":(\[[^\]]*\])', res.text)
            if not m:
                raise Exception('直播间不存在或未开播')
            reps = json.loads(m.group(1))
            if not reps:
                raise Exception('直播间不存在或未开播')
            # 默认输出最高画质：按 bitrate 取最大（无 bitrate 时按 level）
            best = max(reps, key=lambda x: (x.get('bitrate') or x.get('level') or 0))
            return best.get('url') or best.get('playUrl')


def get_real_url(rid):
    try:
        ks = KuaiShou(rid)
        return ks.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    # KPL704668133
    r = input('请输入快手直播房间ID或链接：\n')
    print(get_real_url(r))
