# 秀色直播：https://www.showself.com/
#
# 现行拉流接口（2026-08 实测通过）：
#   1. GET https://service.showself.com/v2/custuser/visitor
#      → data.sessionid（即 accessToken，32 位 hex）+ data.uid（即 tku）
#   2. GET https://service.showself.com/v2/rooms/{rid}/media/latest
#      参数 accessToken / tku / _st1(毫秒时间戳) / _ajaxData1(签名)
#   3. 成功时 data.media_url_web 即为 http-flv 流地址
#
# 签名复刻（XSH5Utils，盐 sh0wselfh5）：
#   排序后 key=encodeURIComponent(value)&... 串 + 'sh0wselfh5' 的 md5。
#   盐 = _hf_constants1..4 各 substring(4) 拼接：showsh→sh, 10000w→0w, showself→self, 2000h5→h5。
#   秀色 sessionid 为 32 位 hex，无特殊字符，无双重编码问题。

from urllib.parse import quote
import requests
import time
import hashlib

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

ROOT = 'https://service.showself.com/v2'
SALT = 'sh0wselfh5'


def _enc(s):
    """复刻 JS encodeURIComponent(trim(s))。"""
    return quote(str(s).strip(), safe="-_.!~*'()")


def _sign(params):
    """复刻 XSH5Utils.bsq/brm/pt：排序 key=value& 串 + 盐 的 md5。"""
    filtered = {k: v for k, v in params.items() if v != ''}
    s = '&'.join(f'{k}={_enc(filtered[k])}' for k in sorted(filtered.keys()))
    return hashlib.md5((s + SALT).encode('utf-8')).hexdigest()


class ShowSelf:

    def __init__(self, rid):
        self.rid = rid
        self.headers = {
            'user-agent': UA,
            'content-type': 'application/json;charset=UTF-8',
        }
        self.s = requests.Session()

    def get_real_url(self):
        # 1. 注册游客，拿 sessionid(accessToken) 与 uid(tku)
        res = self.s.get(f'{ROOT}/custuser/visitor', headers=self.headers, timeout=15)
        res.raise_for_status()
        j = res.json()
        if j.get('status', {}).get('statuscode') != '0':
            raise Exception('注册游客失败')
        access_token = j['data']['sessionid']
        tku = j['data']['uid']

        # 2. 签名并请求媒体接口
        st1 = int(time.time() * 1000)
        sig = _sign({'accessToken': access_token, 'tku': str(tku), '_st1': str(st1)})
        url = (f'{ROOT}/rooms/{self.rid}/media/latest'
               f'?accessToken={access_token}&tku={tku}&_st1={st1}&_ajaxData1={sig}')
        res = self.s.get(url, headers=self.headers, timeout=15)
        res.raise_for_status()
        j = res.json()

        statuscode = j.get('status', {}).get('statuscode')
        if statuscode != '0':
            raise Exception(f'房间不存在或无法进入（statuscode={statuscode}）')

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
        ss = ShowSelf(rid)
        return ss.get_real_url()
    except Exception as e:
        print('Exception：', e)
        return False


if __name__ == '__main__':
    r = input('输入秀色直播房间号：\n')
    print(get_real_url(r))
