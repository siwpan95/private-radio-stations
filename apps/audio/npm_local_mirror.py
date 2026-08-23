# -*- coding: utf-8 -*-
"""Local caching npm registry proxy (streaming version).

pnpm's fetcher aborts transfers when no body bytes arrive for a while
(body timeout). The first version buffered the whole upstream response before
sending anything, so large tarballs (30-120s upstream) always timed out.
This version streams the upstream response chunk-by-chunk while caching.
"""
import hashlib
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("NPM_UPSTREAM", "https://registry.npmmirror.com")
CACHE_DIR = os.environ.get("NPM_CACHE_DIR", os.path.join(os.environ.get("TEMP", "."), "npm-local-mirror-cache"))
PORT = int(os.environ.get("NPM_PROXY_PORT", "8899"))
MAX_AGE = 24 * 3600
CHUNK = 256 * 1024

os.makedirs(CACHE_DIR, exist_ok=True)


def cache_paths(path):
    key = hashlib.sha256(path.encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, key + ".bin"), os.path.join(CACHE_DIR, key + ".meta")


def open_upstream(path):
    url = UPSTREAM + path
    req = urllib.request.Request(url, headers={"User-Agent": "npm-local-mirror/1.1"})
    for attempt in range(3):
        try:
            resp = urllib.request.urlopen(req, timeout=180)
            return resp
        except Exception as e:
            print(f"[proxy] attempt {attempt + 1} failed for {url}: {e}", flush=True)
            if attempt == 2:
                raise
            time.sleep(3 * (attempt + 1))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[proxy] {self.address_string()} - {fmt % args}", flush=True)

    def send_cached(self, cpath):
        total = os.path.getsize(cpath)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(total))
        self.end_headers()
        with open(cpath, "rb") as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except OSError as e:
                    print(f"[proxy] client aborted while serving cache: {e}", flush=True)
                    break

    def rewrite_metadata(self, data):
        """Rewrite tarball URLs in a packument so the client fetches them from us."""
        text = data.decode("utf-8", errors="replace")
        for host in ("https://registry.npmmirror.com", "https://cdn.npmmirror.com",
                     "http://registry.npmmirror.com", "https://registry.npmjs.org"):
            text = text.replace(host, "http://127.0.0.1:%d" % PORT)
        return text.encode("utf-8")

    def stream_and_cache(self, path, cpath, mpath, upstream_path):
        try:
            resp = open_upstream(upstream_path)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except OSError:
                pass
            return
        except Exception as e:
            print(f"[proxy] ERROR {path}: {e}", flush=True)
            body = b'{"error":"upstream failure"}'
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except OSError:
                pass
            return

        is_tarball = ".tgz" in path or path.endswith(".tar.gz")
        ctype = resp.headers.get("Content-Type", "application/octet-stream")

        if is_tarball:
            # Stream binary tarballs chunk-by-chunk. Forward upstream Content-Length
            # so HTTP/1.1 keep-alive clients (npm/undici) can detect end-of-body;
            # without it undici idles out (EIDLETIMEOUT) waiting for the stream to end.
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            cl = resp.headers.get("Content-Length")
            if cl:
                self.send_header("Content-Length", cl)
            self.end_headers()
            tmp = cpath + ".part"
            try:
                with open(tmp, "wb") as cf:
                    while True:
                        chunk = resp.read(CHUNK)
                        if not chunk:
                            break
                        cf.write(chunk)
                        try:
                            self.wfile.write(chunk)
                        except OSError as e:
                            print(f"[proxy] client aborted mid-stream: {e}", flush=True)
                            raise
                os.replace(tmp, cpath)
                with open(mpath, "w", encoding="utf-8") as mf:
                    mf.write(str(time.time()))
            except OSError as e:
                print(f"[proxy] stream aborted (no cache): {e}", flush=True)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
        else:
            # Metadata (small JSON): buffer, rewrite tarball URLs, then serve.
            data = resp.read()
            resp.close()
            try:
                data = self.rewrite_metadata(data)
            except Exception as e:
                print(f"[proxy] rewrite failed: {e}", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except OSError:
                pass
            with open(cpath, "wb") as cf:
                cf.write(data)
            with open(mpath, "w", encoding="utf-8") as mf:
                mf.write(str(time.time()))

    def do_GET(self):
        cpath, mpath = cache_paths(self.path)
        now = time.time()
        if os.path.exists(cpath) and os.path.exists(mpath):
            try:
                mtime = float(open(mpath, encoding="utf-8").read())
                if now - mtime < MAX_AGE:
                    self.send_cached(cpath)
                    return
            except Exception:
                pass
        self.stream_and_cache(self.path, cpath, mpath, self.path)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[proxy] streaming {UPSTREAM} on http://127.0.0.1:{PORT} cache={CACHE_DIR}", flush=True)
    server.serve_forever()
