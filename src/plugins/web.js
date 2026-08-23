// web plugin — HTTP API + 控制面板 UI。只用 Node 内置模块（http/fs/os），
// 无额外运行时依赖（架构对齐电台项目）。
import { Service } from 'cordis'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(__dirname, '..', '..', 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// 局域网 IPv4（面板/播放链接用；没有则回退 127.0.0.1）
function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
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
    this.ctx.logger.info(`control panel: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)
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

  // 所有可用的观看地址（局域网 IP 优先）
  shareUrls() {
    const c = this.ctx.config
    const host = lanIP()
    const p = c.pathName || 'live'
    return {
      host,
      rtsp: `rtsp://${host}:${c.rtspPort}/${p}`,
      hls: `http://${host}:${c.hlsPort}/${p}/index.m3u8`,
      webrtc: `http://${host}:${c.webrtcPort}/${p}/`,
      webrtcLocal: `http://127.0.0.1:${c.webrtcPort}/${p}/`,
      panel: `http://${host}:${c.port}/`,
    }
  }

  async handle(req, res) {
    this.cors(res)
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const pathname = decodeURIComponent(url.pathname)
    const { station, streamer, recorder, presets, logfile, mediamtx } = this.ctx

    // ---- API ----
    if (pathname === '/api/status') {
      const s = station.status()
      s.uptime = Math.round(process.uptime())
      s.streamer = streamer.status ? streamer.status() : {}
      s.recorder = recorder.status ? recorder.status() : {}
      s.recordings = recorder.list ? recorder.list() : []
      s.mediamtx = mediamtx.status ? await mediamtx.status() : {}
      s.logfile = logfile.status ? logfile.status() : {}
      s.recent_errors = logfile.recentErrors ? logfile.recentErrors() : []
      s.urls = this.shareUrls()
      return this.json(res, 200, s)
    }

    if (pathname === '/api/relay' && req.method === 'POST') {
      const body = await this.readJson(req)
      const u = (body.url || '').trim()
      if (!u) return this.json(res, 400, { error: 'url required' })
      const fallbacks = Array.isArray(body.fallbacks)
        ? body.fallbacks.map((x) => String(x).trim()).filter(Boolean)
        : []
      const cfg = this.ctx.config
      station.setRelay(u, (body.name || '').trim(), fallbacks, {
        transcode: body.transcode !== undefined ? body.transcode === true : cfg.transcode,
        record: body.record !== undefined ? body.record === true : cfg.record.enabled,
      })
      return this.json(res, 200, station.status())
    }

    if (pathname === '/api/relay/stop' && req.method === 'POST') {
      station.stopRelay()
      return this.json(res, 200, station.status())
    }

    if (pathname === '/api/record' && req.method === 'POST') {
      const body = await this.readJson(req)
      if (body.on) recorder.start()
      else recorder.stop()
      return this.json(res, 200, recorder.status())
    }

    if (pathname === '/api/recordings' && req.method === 'GET') {
      return this.json(res, 200, { recordings: recorder.list() })
    }

    if (pathname === '/api/recordings' && req.method === 'DELETE') {
      const name = url.searchParams.get('name') || ''
      const ok = recorder.remove(name)
      return this.json(res, ok ? 200 : 400, { ok, recordings: recorder.list() })
    }

    if (pathname === '/api/presets' && req.method === 'GET') {
      return this.json(res, 200, { presets: presets.list() })
    }

    if (pathname === '/api/presets' && req.method === 'POST') {
      const body = await this.readJson(req)
      const list = presets.add({
        name: (body.name || '').trim(),
        url: (body.url || '').trim(),
        desc: (body.desc || '').trim(),
        icon: (body.icon || '').trim(),
      })
      return this.json(res, 200, { presets: list })
    }

    if (pathname === '/api/presets' && req.method === 'DELETE') {
      const u = url.searchParams.get('url') || ''
      const list = presets.remove(u)
      return this.json(res, 200, { presets: list })
    }

    // ---- 录像文件下载 ----
    const recMatch = pathname.match(/^\/recordings\/(.+)$/)
    if (recMatch && req.method === 'GET') {
      const name = path.normalize(recMatch[1]).replace(/^(\.\.[/\\])+/, '')
      const dir = recorder.dir
      const filePath = path.join(dir, name)
      if (!filePath.startsWith(dir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404)
        return res.end('not found')
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
        'Content-Length': fs.statSync(filePath).size,
      })
      fs.createReadStream(filePath).pipe(res)
      return
    }

    // ---- 静态 / SPA 根 ----
    if (pathname === '/' || pathname === '/index.html') {
      return this.serveFile(res, path.join(PUBLIC, 'index.html'), '.html')
    }
    const staticPath = path.join(PUBLIC, path.normalize(pathname).replace(/^(\.\.)[/\\]/, ''))
    if (staticPath.startsWith(PUBLIC) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
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

WebService.inject = ['config', 'station', 'streamer', 'recorder', 'presets', 'logfile', 'mediamtx']

export default function webPlugin(ctx) {
  ctx.plugin(WebService)
}
