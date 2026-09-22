// web plugin — HTTP API + 控制面板 UI。基础设施（server 生命周期/cors/json/
// readJson/serveFile/MIME/lanIP）来自 @relay/core/web-base，这里只写路由。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { WebBase, lanIP } from '@relay/core/src/web-base.js'
import { redactSecrets } from '@relay/core/src/settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(__dirname, '..', '..', 'public')
const ROOT = path.resolve(__dirname, '..', '..', '..', '..')

class WebService extends WebBase {
  // 卫星影像状态：列出已离线渲染好的成品（mp4），供面板直接转播。
  // 设计要点（见 docs/SATELLITE_SOURCES.md）：卫星画面无法实时转码（本机无
  // 硬件编码），因此由 npm run satellite 离线生成 mp4，这里只负责发现与列举。
  satelliteStatus() {
    const cfg = this.ctx.config.satellite || {}
    // 注意：ctx.config.root 已是 apps/video（config.js 用 __dirname/'..','..' 解析），
    // 不能再拼 'apps','video'，否则路径会变成 .../apps/video/apps/video 而永远列不出成品。
    const dir = path.resolve(this.ctx.config.root, cfg.dir || 'satellite')
    const out = { enabled: cfg.enabled !== false, dir, source: cfg.source, zoom: cfg.zoom, days: cfg.days, files: [] }
    try {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (!f.toLowerCase().endsWith('.mp4')) continue
          const p = path.join(dir, f)
          const st = fs.statSync(p)
          out.files.push({
            name: f,
            size: st.size,
            mtime: st.mtime.toISOString(),
            url: 'file:///' + p.replace(/\\/g, '/'),
          })
        }
        // 新的排前面
        out.files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      }
    } catch {
      /* 目录不可读时返回空列表，不影响 /api/status 整体可用 */
    }
    return out
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
    const { station, streamer, recorder, presets, logfile, mediamtx, channels, resolver, settings, launcher } = this.ctx

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
      if (settings) s.settings = settings.status()
      if (launcher) s.launcher = launcher.status()
      s.satellite = this.satelliteStatus()
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

    // ---- 卫星影像：成品列表 + 手动触发一次「每日生成」----
    if (pathname === '/api/satellite' && req.method === 'GET') {
      return this.json(res, 200, this.satelliteStatus())
    }
    if (pathname === '/api/satellite/generate' && req.method === 'POST') {
      const st = this.satelliteStatus()
      if (!st.enabled) return this.json(res, 400, { error: 'satellite.enabled=false，已禁用' })
      const script = path.resolve(ROOT, 'scripts', 'satellite-daily.mjs')
      if (!fs.existsSync(script)) {
        return this.json(res, 500, { error: '缺少 scripts/satellite-daily.mjs' })
      }
      // 复用每日编排脚本：它内置进程锁，因此重复点击、或与 cordis 调度服务 /
      // WorkBuddy 自动化同时触发时，都只会真正生成一次。
      // 生成耗时数分钟，故 detached + unref 后台跑，接口立即返回 202。
      const child = spawn(process.execPath, [script], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return this.json(res, 202, { started: true, pid: child.pid, dir: st.dir })
    }

    // ---- 桌面播放器快捷入口（前台拉起 PluginPlayer + 控制通道）----
    if (pathname === '/api/player' && req.method === 'GET') {
      return this.json(res, 200, launcher ? launcher.status() : { enabled: false })
    }
    if (pathname === '/api/player/launch' && req.method === 'POST') {
      if (!launcher) return this.json(res, 503, { error: 'launcher 插件未启用' })
      const body = await this.readJson(req)
      const r = await launcher.launchStart((body.url || '').trim())
      return this.json(res, 200, r)
    }
    if (pathname === '/api/player/quit' && req.method === 'POST') {
      if (!launcher) return this.json(res, 503, { error: 'launcher 插件未启用' })
      const r = await launcher.launchStop()
      return this.json(res, 200, r)
    }
    if (pathname === '/api/player/control' && req.method === 'POST') {
      if (!launcher) return this.json(res, 503, { error: 'launcher 插件未启用' })
      const body = await this.readJson(req)
      const action = String(body.action || '')
      const r = await launcher.launchControl(action, { path: (body.path || '').trim(), pos: Number(body.pos || 0) })
      return this.json(res, 200, r)
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

    // ---- 分层设置（P9）----
    const settingsMatch = pathname.match(/^\/api\/settings\/(.+)$/)
    if (settingsMatch && req.method === 'GET') {
      const r = settings.resolve(settingsMatch[1])
      if (!r) return this.json(res, 404, { error: '未知命名空间' })
      return this.json(res, 200, { ...r, value: redactSecrets(r.value) })
    }
    if (settingsMatch && req.method === 'PUT') {
      const body = await this.readJson(req)
      try {
        const r = settings.set(settingsMatch[1], body.patch, body.expectedRevision)
        return this.json(res, 200, { ns: r.ns, revision: r.revision, value: redactSecrets(r.value) })
      } catch (e) {
        return this.json(res, e.code === 'SETTINGS_CONFLICT' ? 409 : 400, { error: e.message, code: e.code })
      }
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
          // 自动续播：带平台信息 → 到期/断流时 station 自动重解析换源
          refreshInfo: { platform: body.platform, room: String(body.room).trim() },
          expiresAt: typeof r4.expiresAt === 'number' ? r4.expiresAt : 0,
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

WebService.inject = [...WebBase.inject, 'station', 'streamer', 'recorder', 'presets', 'logfile', 'mediamtx', 'channels', 'resolver', 'settings', 'launcher']

export default function webPlugin(ctx) {
  ctx.plugin(WebService)
}
