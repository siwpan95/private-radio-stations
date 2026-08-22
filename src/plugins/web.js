// web plugin — HTTP API + control-panel UI. Uses only Node built-ins
// (http/fs) so there are no extra runtime dependencies.
import { Service } from 'cordis'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(__dirname, '..', '..', 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/MP2T',
  '.json': 'application/json; charset=utf-8',
}

class WebService extends Service {
  constructor(ctx) {
    super(ctx, 'web')
    this.server = null
    ctx.on('ready', () => this.start())
    ctx.on('dispose', () => {
      if (this.server) {
        try { this.server.close() } catch { /* ignore */ }
      }
    })
  }

  async start() {
    const server = http.createServer((req, res) => this.handle(req, res))
    this.server = server
    const { port, host } = this.ctx.config
    await new Promise((resolve) => server.listen(port, host, resolve))
    this.ctx.logger.info(`control panel: http://${host}:${port}`)
  }

  cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  json(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  async readJson(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) }
      })
    })
  }

  async handle(req, res) {
    this.cors(res)
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const pathname = decodeURIComponent(url.pathname)
    const { station, streamer, hls, browse, presets, config } = this.ctx

    // ---- API ----
    if (pathname === '/api/status') {
      return this.json(res, 200, station.status())
    }

    if (pathname === '/api/relay' && req.method === 'POST') {
      const body = await this.readJson(req)
      const url2 = (body.url || '').trim()
      if (!url2) return this.json(res, 400, { error: 'url required' })
      station.setRelay(url2, (body.name || '').trim(), body.fallbacks || [])
      return this.json(res, 200, station.status())
    }

    if (pathname === '/api/relay/stop' && req.method === 'POST') {
      station.stopRelay()
      return this.json(res, 200, station.status())
    }

    if (pathname === '/api/browse' && req.method === 'GET') {
      const q = url.searchParams.get('q') || ''
      const results = await browse.search(q)
      return this.json(res, 200, { query: q, results })
    }

    if (pathname === '/api/presets' && req.method === 'GET') {
      return this.json(res, 200, { presets: presets.list() })
    }

    if (pathname === '/api/presets' && req.method === 'POST') {
      const body = await this.readJson(req)
      const list = presets.add((body.name || '').trim(), (body.url || '').trim())
      return this.json(res, 200, { presets: list })
    }

    if (pathname === '/api/presets' && req.method === 'DELETE') {
      const u = url.searchParams.get('url') || ''
      const list = presets.remove(u)
      return this.json(res, 200, { presets: list })
    }

    // ---- streams ----
    // Helper: pipe a spawned ffmpeg child's stdout to the response and make
    // sure the child is killed when the client disconnects.
    const pipeChild = (child) => {
      child.stdout.pipe(res)
      child.on('exit', () => { if (!res.writableEnded) res.end() })
      req.on('close', () => { try { child.kill('SIGKILL') } catch { /* ignore */ } })
    }

    if (pathname === '/stream' && req.method === 'GET') {
      if (station.mode !== 'relay') {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('not relaying')
      }
      const bitrate = config.defaultBitrate || 128
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      if (config.ffmpegOk()) {
        const child = await streamer.relayMount(bitrate)
        if (!child) {
          res.end('no source')
          return
        }
        pipeChild(child)
        return
      }
      // No ffmpeg: Node fetch fallback (lower reliability on some sources).
      try {
        for await (const chunk of streamer.fetchStream()) {
          if (res.writableEnded) break
          res.write(chunk)
        }
      } catch (e) {
        this.ctx.logger.error(`/stream fallback error: ${e && e.message}`)
      }
      return res.end()
    }

    const mountMatch = pathname.match(/^\/stream\/(\d+)$/)
    if (mountMatch && req.method === 'GET') {
      const k = Number(mountMatch[1])
      if (!config.transcodeMounts.includes(k) || !config.ffmpegOk()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('mount unavailable')
      }
      const child = await streamer.relayMount(k)
      if (!child) {
        res.writeHead(404)
        return res.end('no source')
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      pipeChild(child)
      return
    }

    // ---- HLS (only while relaying) ----
    const hlsMatch = pathname.match(/^\/hls\/(.+)$/)
    if (hlsMatch && req.method === 'GET') {
      if (station.mode !== 'relay') {
        res.writeHead(404)
        return res.end('not relaying')
      }
      const file = hlsMatch[1]
      const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '')
      const filePath = path.join(hls.hlsDir, safe)
      if (
        !filePath.startsWith(hls.hlsDir) ||
        !/\.(m3u8|ts)$/.test(filePath) ||
        !fs.existsSync(filePath)
      ) {
        res.writeHead(404)
        return res.end('not found')
      }
      const ext = path.extname(filePath)
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      fs.createReadStream(filePath).pipe(res)
      return
    }

    // ---- static / SPA root ----
    if (pathname === '/' || pathname === '/index.html') {
      return this.serveFile(res, path.join(PUBLIC, 'index.html'), '.html')
    }
    const staticPath = path.join(PUBLIC, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
    if (staticPath.startsWith(PUBLIC) && fs.existsSync(staticPath)) {
      const ext = path.extname(staticPath)
      return this.serveFile(res, staticPath, ext)
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  serveFile(res, filePath, ext) {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end('not found')
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(data)
    })
  }
}

WebService.inject = ['config', 'station', 'streamer', 'hls', 'browse', 'presets']

export default function webPlugin(ctx) {
  ctx.plugin(WebService)
}
