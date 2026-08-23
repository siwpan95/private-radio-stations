// web plugin — HTTP API + 控制面板 UI。基础设施（server 生命周期/cors/json/
// readJson/serveFile/MIME/lanIP）来自 @relay/core/web-base，这里只写路由。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebBase, lanIP } from '@relay/core/src/web-base.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(__dirname, '..', '..', 'public')

class WebService extends WebBase {
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
    const { station, streamer, recorder, presets, logfile, mediamtx, channels, resolver } = this.ctx

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
      s.presets = presets.list()
      if (channels) s.channels = { files: channels.files() }
      if (resolver) s.platformCount = resolver.platformsList().length
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

    // 优雅关闭（仅本机 loopback 允许）
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      const remote = req.socket.remoteAddress || ''
      const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!isLoopback) return this.json(res, 403, { error: '仅允许本机关闭' })
      this.ctx.logger.info('shutdown requested via /api/shutdown')
      this.json(res, 200, { ok: true })
      setTimeout(() => {
        this.ctx.emit('dispose')
        setTimeout(() => process.exit(0), 500)
      }, 150)
      return
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

    // ---- 频道库（IPTV m3u）----
    if (pathname === '/api/channels' && req.method === 'GET') {
      const file = url.searchParams.get('file') || ''
      return this.json(res, 200, {
        playlists: channels.files(),
        channels: channels.get(file),
      })
    }

    if (pathname === '/api/playlist' && req.method === 'POST') {
      const body = await this.readJson(req)
      const r2 = await channels.importFromUrl(body.url, body.name)
      return this.json(res, r2.ok ? 200 : 400, r2)
    }

    if (pathname === '/api/playlist' && req.method === 'DELETE') {
      const file = url.searchParams.get('file') || ''
      const ok = channels.remove(file)
      return this.json(res, ok ? 200 : 400, { ok, playlists: channels.files() })
    }

    // ---- 平台直播解析（real-url）----
    if (pathname === '/api/platforms' && req.method === 'GET') {
      return this.json(res, 200, { platforms: resolver.platformsList() })
    }

    if (pathname === '/api/resolve' && req.method === 'POST') {
      const body = await this.readJson(req)
      const r3 = await resolver.resolve(body.platform, body.room)
      return this.json(res, r3.ok ? 200 : 400, r3)
    }

    if (pathname === '/api/relay/resolve' && req.method === 'POST') {
      const body = await this.readJson(req)
      const meta = resolver.platformsList().find((p) => p.module === body.platform)
      const r4 = await resolver.resolve(body.platform, body.room)
      if (!r4.ok) return this.json(res, 400, r4)
      const cfg = this.ctx.config
      station.setRelay(
        r4.url,
        (body.name || '').trim() || ((meta ? meta.label : body.platform) + ' ' + String(body.room).trim()),
        [],
        {
          transcode: body.transcode !== undefined ? body.transcode === true : cfg.transcode,
          record: body.record !== undefined ? body.record === true : cfg.record.enabled,
        }
      )
      return this.json(res, 200, { resolved: r4, status: station.status() })
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
}

WebService.inject = [...WebBase.inject, 'station', 'streamer', 'recorder', 'presets', 'logfile', 'mediamtx', 'channels', 'resolver']

export default function webPlugin(ctx) {
  ctx.plugin(WebService)
}
