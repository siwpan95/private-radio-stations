# -*- coding: utf-8 -*-
"""mediamtx 发布包分片并行下载（精确 Range 续传，坏片自动重下）。

用法: python dl_mtx.py
"""
import concurrent.futures
import hashlib
import math
import os
import sys
import time
import urllib.request

URL = "https://ghfast.top/https://github.com/bluenviron/mediamtx/releases/download/v1.20.1/mediamtx_v1.20.1_windows_amd64.zip"
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FINAL = os.path.join(PROJECT_ROOT, "mediamtx-release.zip")
DIR = os.path.join(PROJECT_ROOT, "data", "_dl_parts")
TOTAL = 27405205
N = 8
EXPECT_SHA = "dc970f8e1f3ad58edafcf536bcd1ffe0adcb4390e7ace9377694a9ea2c1ebe53"
CHUNK = math.ceil(TOTAL / N)
os.makedirs(DIR, exist_ok=True)


def part_range(i):
    start = i * CHUNK
    if start >= TOTAL:
        return None
    end = min(TOTAL - 1, (i + 1) * CHUNK - 1)
    return start, end


def worker(i):
    rng = part_range(i)
    if rng is None:
        return None
    start, end = rng
    expect = end - start + 1
    path = os.path.join(DIR, f"part_{i}.bin")
    attempts = 0
    deadline = time.time() + 90 * 60  # 总时限 90 分钟
    while time.time() < deadline:
        attempts += 1
        cur = os.path.getsize(path) if os.path.exists(path) else 0
        if cur > expect:  # 数据损坏（对端错误响应）：删掉重来
            os.remove(path)
            cur = 0
        if cur == expect:
            return True
        req_start = start + cur
        req = urllib.request.Request(
            URL,
            headers={"Range": f"bytes={req_start}-{end}", "User-Agent": "mtx-dl/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                if resp.status != 206:
                    # 对端不支持/忽略 Range：本次响应不可用，清空重试
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                    print(f"[part {i}] status {resp.status}, restarting", flush=True)
                    time.sleep(3)
                    continue
                with open(path, "ab") as f:
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
        except Exception as e:
            print(f"[part {i}] attempt {attempts} error: {e}", flush=True)
            time.sleep(3)
    print(f"[part {i}] GAVE UP after {attempts} attempts", flush=True)
    return False


def main():
    ranges = [r for r in (part_range(i) for i in range(N)) if r]
    print(f"downloading {TOTAL} bytes in {len(ranges)} parts via {URL}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
        results = list(pool.map(worker, range(N)))
    ok = all(r is not False for r in results)
    sizes = []
    for i in range(N):
        p = os.path.join(DIR, f"part_{i}.bin")
        sizes.append((i, os.path.getsize(p) if os.path.exists(p) else 0))
    total_now = sum(s for _, s in sizes)
    print(f"parts: {total_now}/{TOTAL}  {sizes}", flush=True)
    if not ok or total_now != TOTAL:
        print("DOWNLOAD INCOMPLETE", flush=True)
        sys.exit(1)

    with open(FINAL, "wb") as out:
        for i in range(N):
            p = os.path.join(DIR, f"part_{i}.bin")
            with open(p, "rb") as f:
                out.write(f.read())
    print(f"final size={os.path.getsize(FINAL)}", flush=True)

    h = hashlib.sha256()
    with open(FINAL, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    got = h.hexdigest()
    print(f"sha256={got}", flush=True)
    if got == EXPECT_SHA:
        print("SHA256 OK", flush=True)
    else:
        print("SHA256 MISMATCH", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
