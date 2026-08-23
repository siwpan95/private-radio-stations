# 抖音直播真实流地址（由 real-url 原始脚本重构为可导入模块）
import re

import requests

headers = {
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1',
}


def get_real_url(url):
    try:
        if re.match(r'\d{19}', url):
            room_id = url
        else:
            url2 = re.search(r'(https.*)', url).group(1)
            response = requests.head(url2, headers=headers)
            location = response.headers['location']
            room_id = re.search(r'\d{19}', location).group(0)

        h2 = dict(headers)
        h2.update({
            'authority': 'webcast.amemv.com',
            'cookie': '_tea_utm_cache_1128={%22utm_source%22:%22copy%22%2C%22utm_medium%22:%22android%22%2C%22utm_campaign%22:%22client_share%22}',
        })
        params = (
            ('type_id', '0'),
            ('live_id', '1'),
            ('room_id', room_id),
            ('app_id', '1128'),
        )
        resp = requests.get('https://webcast.amemv.com/webcast/room/reflow/info/', headers=h2, params=params).json()
        return resp['data']['room']['stream_url']['hls_pull_url']
    except Exception:
        return False
