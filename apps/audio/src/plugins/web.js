// web plugin — HTTP API + 控制面板 + 媒体直发。基础设施（server 生命周期/
// cors/json/readJson/serveFile/MIME）来自 @relay/core/web-base，这里保留
// ICY 注入、媒体路由与空闲态兜底。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { WebBase, MIME } from '@relay/core/src/web-base.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(__dirname, '..', '..', 'public')

// ---- ICY 元数据（VLC/Winamp 等播放器显示「正在转播」标题）----
// 客户端带 Icy-MetaData: 1 请求时，每 metaint 字节音频后插入一个元数据块。
const ICY_METAINT = 8192

function icyMetaBlock(title) {
  if (!title) return Buffer.from([0])
  const safe = String(title).replace(/'/g, '’')   // 单引号会破坏 StreamTitle 格式
  const text = Buffer.from("StreamTitle='" + safe + "';", 'utf8')
  const len = Math.ceil(text.length / 16) * 16
  const buf = Buffer.alloc(1 + len)
  buf[0] = len / 16
  text.copy(buf, 1)
  return buf
}

// 返回一个 push(chunk) 函数：按 metaint 切分音频字节并插入元数据块。
function icyInjector(res, getTitle, metaint = ICY_METAINT) {
  let since = 0
  let last = ''
  return function push(chunk) {
    let off = 0
    while (off < chunk.length) {
      const take = Math.min(metaint - since, chunk.length - off)
      if (take > 0) {
        const ok = res.write(chunk.subarray(off, off + take))
        off += take
        since += take
        if (!ok) return false   // 背压交给调用方处理
      }
      if (since >= metaint) {
        const t = getTitle()
        res.write(icyMetaBlock(t === last ? '' : t))
        last = t
        since = 0
      }
    }
    return true
  }
}

class WebService extends WebBase {
  async handle(req, res) {
    this.cors(res)
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const pathname = decodeURIComponent(url.pathname)
    const { station, streamer, hls, browse, presets, config, logfile } = this.ctx

    // ---- API ----
    if (pathname === '/api/status') {
      const s = station.status()
      s.uptime = Math.round(process.uptime())
      s.ffmpeg_children = streamer.children ? streamer.children.size : 0
      s.hls = hls.status ? hls.status() : {}
      s.logfile = logfile.status ? logfile.status() : {}
      s.recent_errors = logfile.recentErrors ? logfile.recentErrors() : []
      return this.json(res, 200, s)
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

    // 优雅关闭（仅本机 loopback 允许，与视频应用约定一致）
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
        return this.serveIdleStream(req, res)
      }
      const bitrate = config.defaultBitrate || 128
      const wantsIcy = String(req.headers['icy-metadata'] || '').trim() === '1'
      const headers = {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      }
      if (wantsIcy) {
        headers['icy-metaint'] = String(ICY_METAINT)
        headers['icy-name'] = 'Private Radio Relay'
        headers['icy-genre'] = 'Various'
        headers['icy-br'] = String(bitrate)
      }
      res.writeHead(200, headers)
      const push = wantsIcy
        ? icyInjector(res, () => (station.current ? station.current.name : ''))
        : (b) => { if (!res.writableEnded) res.write(b); return true }
      if (config.ffmpegOk()) {
        const child = await streamer.relayMount(bitrate)
        if (!child) {
          res.end('no source')
          return
        }
        const onData = (c) => {
          if (res.writableEnded) return
          const ok = push(c)
          if (ok === false && child.stdout && !child.killed) {
            child.stdout.pause()
            res.once('drain', () => { if (child.stdout && !child.killed) child.stdout.resume() })
          }
        }
        child.stdout.on('data', onData)
        child.stdout.on('end', () => { if (!res.writableEnded) res.end() })
        child.on('exit', () => { if (!res.writableEnded) res.end() })
        req.on('close', () => { try { child.kill('SIGKILL') } catch { /* ignore */ } })
        return
      }
      // No ffmpeg: Node fetch fallback (lower reliability on some sources).
      try {
        for await (const chunk of streamer.fetchStream()) {
          if (res.writableEnded) break
          push(chunk)
        }
      } catch (e) {
        this.ctx.logger.error('/stream fallback error: ' + (e && e.message))
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

  // 空闲态兜底：循环播放 jingle.mp3（台标音），不再 409。
  // 有 ffmpeg：ffmpeg 循环 + 实时节流；无 ffmpeg：Node 按默认码率循环喂字节；
  // 连 jingle 都没有则保持连接静音（客户端听到无声）。
  serveIdleStream(req, res) {
    const { config, station } = this.ctx
    const wantsIcy = String(req.headers['icy-metadata'] || '').trim() === '1'
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    }
    if (wantsIcy) {
      headers['icy-metaint'] = String(ICY_METAINT)
      headers['icy-name'] = 'Private Radio Relay'
      headers['icy-genre'] = 'Idle'
      headers['icy-br'] = String(config.defaultBitrate || 128)
    }
    res.writeHead(200, headers)
    const title = () => (station.mode === 'relay' && station.current ? station.current.name : '待机中（未转播）')
    const push = wantsIcy
      ? icyInjector(res, title)
      : (b) => { if (!res.writableEnded) res.write(b); return true }

    const jingle = path.resolve(config.root, 'jingle.mp3')
    if (config.ffmpegOk() && fs.existsSync(jingle)) {
      const child = spawn(config.ffmpeg,
        ['-stream_loop', '-1', '-re', '-i', jingle, '-acodec', 'copy', '-f', 'mp3', '-'],
        { stdio: ['ignore', 'pipe', 'ignore'] })
      const onData = (c) => { if (!res.writableEnded) push(c) }
      child.stdout.on('data', onData)
      child.on('exit', () => { if (!res.writableEnded) res.end() })
      req.on('close', () => { try { child.kill('SIGKILL') } catch { /* ignore */ } })
      return
    }
    if (fs.existsSync(jingle)) {
      // 无 ffmpeg：按默认码率循环喂 jingle 字节
      const data = fs.readFileSync(jingle)
      const csize = config.chunkSize || 4096
      const bps = ((config.defaultBitrate || 128) * 1000) / 8
      let off = 0
      const timer = setInterval(() => {
        if (res.writableEnded) { clearInterval(timer); return }
        const end = Math.min(off + csize, data.length)
        push(data.subarray(off, end))
        off = end >= data.length ? 0 : end
      }, (csize / bps) * 1000)
      req.on('close', () => clearInterval(timer))
      return
    }
    // 无 jingle 无 ffmpeg：静音保持连接
    req.on('close', () => { if (!res.writableEnded) res.end() })
  }
}

WebService.inject = [...WebBase.inject, 'station', 'streamer', 'hls', 'browse', 'presets', 'logfile']

export default function webPlugin(ctx) {
  ctx.plugin(WebService)
}
