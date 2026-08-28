# -*- coding: utf-8 -*-
"""real-url 平台解析包装器：python resolve.py <platform> <room>  → 一行 JSON

平台模块输出会混杂打印信息，最终结果始终是【最后一行 JSON】。
"""
import importlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)  # iqiyi.py 需要读取同目录的 iqiyi.js
sys.path.insert(0, HERE)


def extract_url(v):
    """兼容各模块返回：str / dict / list（http/https/rtmp 直链均接受）"""
    if isinstance(v, dict):
        for k in ('url', 'real_url', 'stream_url', 'flv_url', 'hls_url'):
            if v.get(k) and isinstance(v[k], str) and v[k].startswith(('http', 'rtmp')):
                return v[k]
        # bilibili 返回 {线路1: url, ...} 这类结构
        for u in v.values():
            if isinstance(u, str) and u.startswith(('http', 'rtmp')):
                return u
        return None
    if isinstance(v, (list, tuple)) and v:
        return extract_url(v[0])
    if isinstance(v, str) and v.startswith(('http', 'rtmp')):
        return v
    return None


def find_entry(mod, room):
    """模块级 get_real_url；没有的话退回第一个含 get_real_url 方法的类（如 douyu）"""
    fn = getattr(mod, 'get_real_url', None)
    if fn is not None:
        return lambda: fn(room)
    import inspect
    for _name, obj in vars(mod).items():
        if inspect.isclass(obj) and hasattr(obj, 'get_real_url'):
            try:
                inst = obj(room)
            except TypeError:
                inst = obj()
            return inst.get_real_url
    raise RuntimeError('module has no get_real_url entry')


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': 'usage: resolve.py <platform> <room>'}, ensure_ascii=True))
        return
    platform, room = sys.argv[1], sys.argv[2]
    try:
        mod = importlib.import_module(platform)
        url = find_entry(mod, room)()
        u = extract_url(url)
        if u:
            print(json.dumps({'ok': True, 'url': u}, ensure_ascii=True))
        else:
            print(json.dumps({'ok': False, 'error': '未获取到播放地址（未开播或规则失效）', 'raw': str(url)[:200]}, ensure_ascii=True))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)[:300]}, ensure_ascii=True))


if __name__ == '__main__':
    main()
