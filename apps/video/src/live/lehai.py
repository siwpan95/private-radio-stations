# 乐嗨直播：https://www.lehaitv.com/
#
# 现行拉流接口（2026-08 实测通过）：
#   1. GET https://service.lehaitv.com/v2/user/registervisitor
#      → data.sessionid（即 accessToken，服务端已 URL 编码）+ data.uid（即 tku）
#   2. GET https://service.lehaitv.com/v2/room/{rid}/media/advanceInfoRoom
#      参数 _st1(毫秒时间戳) / accessToken / tku / _ajaxData1(签名)
#   3. 成功时 data.media_url_web 即为 http-flv 流地址
#
# 签名复刻（XSH5Utils，盐 1eha12h5）：
#   排序后 key=encodeURIComponent(value)&... 串 + '1eha12h5' 的 md5。
#   盐 = _hf_constants1..4 各 substring(4) 拼接：sowh1e→1e, 1000ha→ha, butr12→12, 2000h5→h5。
#   注意：accessToken 来自服务端已是 URL 编码（含 %2B/%2F/%3D），签名时会被再编码一次
#   （%→%25 双重编码），但请求 URL 里必须用单次编码值，故手动拼 URL（不用 requests 的
#   params=，避免二次编码）。

from urllib.parse import quote
import requests
import time
import hashlib

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

ROOT = 'https://service.lehaitv.com/v2'
SALT = '1eha12h5'


def _enc(s):
    """复刻 JS encodeURIComponent(trim(s))。"""
    return quote(str(s).strip(), safe="-_.!~*'()")


def _sign(params):
    """复刻 XSH5Utils.bsq/brm/pt：排序 key=value& 串 + 盐 的 md5。"""
    filtered = {k: v for k, v in params.items() if v != ''}
    s = '&'.join(f'{k}={_enc(filtered[k])}' for k in sorted(filtered.keys()))
    return hashlib.md5((s + SALT).encode('utf-8')).hexdigest()


class LeHai:

    def __init__(self, rid):
        self.rid = rid

    def get_real_url(self):
        s = requests.Session()
        s.headers.update({'User-Agent': UA})

        # 1. 注册游客，拿 sessionid(accessToken) 与 uid(tku)
        r = s.get(f'{ROOT}/user/registervisitor', timeout=15)
        r.raise_for_status()
        j = r.json()
        if j.get('status', {}).get('statuscode') != '0':
            raise Exception('注册游客失败')
        access_token = j['data']['sessionid']
        tku = j['data']['uid']

        # 2. 签名并请求拉流接口（accessToken 用服务端单次编码值，不再二次编码）
        st1 = int(time.time() * 1000)
        sig = _sign({'accessToken': access_token, 'tku': str(tku), '_st1': str(st1)})
        url = (f'{ROOT}/room/{self.rid}/media/advanceInfoRoom'
               f'?accessToken={access_token}&tku={tku}&_st1={st1}&_ajaxData1={sig}')
        r = s.get(url, timeout=15)
        r.raise_for_status()
        j = r.json()

        statuscode = j.get('status', {}).get('statuscode')
        if statuscode != '0':
            raise Exception(f'房间不存在或无法查看（statuscode={statuscode}）')

        data = j.get('data', {})
        if str(data.get('live_status')) != '1':
            raise Exception('未开播')

        real_url = (data.get('media_url_web')
                    or data.get('medial_url_app_for_h264')
                    or data.get('media_url_app'))
        if not real_url:
            raise Exception('未获取到播放地址')
        return real_url


def get_real_url(rid):
    try:
        lh = LeHai(rid)
        return lh.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    r = input('输入乐嗨直播房间号：\n')
    print(get_real_url(r))
