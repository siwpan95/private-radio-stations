// launcher plugin — 桌面播放器快捷入口（2026-09-14，修正目标到 video 面板）
// ---------------------------------------------------------------------------
// 在 video 控制面板（http://localhost:8100/）里提供一个「拉起 G:\local\pluginplayer」
// 的入口：点一下就在本机弹出 PluginPlayer 可见窗口，并可用控制通道驱动播放。
//
//   · 进程：pluginplayer.exe --allow-network-input --rpc-port <port> --rpc-token <token> [url?]
//   · 控制：127.0.0.1:<port> 换行分隔 JSON（首条必须是 auth），驱动
//           player.open / player.play / player.pause / player.stop / player.seek / app.quit
//   · 与 radio 应用的「本机监听 / 快捷入口」完全独立（独立 RPC 端口 7921），互不干扰。
//
// 契约：GET /api/player；POST /api/player/launch {url?}；POST /api/player/quit；
//       POST /api/player/control {action, path?, pos?}
import { Service } from 'cordis'
import { spawn } from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_EXE = 'G:\\local\\pluginplayer\\dist\\pluginplayer.exe'

/** 控制通道客户端：换行分隔 JSON over TCP（协议见 pluginplayer src/core/control.h）。 */
class Rpc {
  constructor(port, token) {
    this.port = port
    this.token = token
    this.sock = null
    this.nextId = 1
    this.buf = ''
    this.waiters = new Map()
    this.closed = true
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: this.port })
      const timer = setTimeout(() => {
        try { s.destroy() } catch { /* ignore */ }
        reject(new Error('控制通道连接超时'))
      }, timeoutMs)
      s.on('connect', () => {
        clearTimeout(timer)
        this.sock = s
        this.closed = false
        s.on('data', (d) => this._onData(d))
        s.on('close', () => {
          this.closed = true
          for (const [, w] of this.waiters) w.reject(new Error('连接已关闭'))
          this.waiters.clear()
        })
        s.on('error', () => { /* 由 close 统一处理 */ })
        // call() 解析出的是**应答的 result 字段**，不是整包。
        // auth 的 result 形如 {"authenticated":true,"abi":3} —— 没有 ok 字段，
        // 判 ok 会把成功的认证误判为失败（踩过的坑）。
        this.call('auth', { token: this.token }).then((r) => {
          if (!r || r.authenticated !== true) return reject(new Error('认证失败: ' + JSON.stringify(r)))
          resolve()
        }, reject)
      })
      s.on('error', (e) => { clearTimeout(timer); reject(e) })
    })
  }

  _onData(d) {
    this.buf += d.toString('utf8')
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (obj && obj.id != null && this.waiters.has(obj.id)) {
        const w = this.waiters.get(obj.id)
        this.waiters.delete(obj.id)
        if (obj.ok === false) w.reject(new Error(obj.error || '远端错误'))
        else w.resolve(obj.result)
      }
    }
  }

  call(method, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.closed) return reject(new Error('未连接'))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error('超时: ' + method))
      }, timeoutMs)
      this.waiters.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.sock.write(JSON.stringify({ id, method, params: params || {} }) + '\n')
    })
  }

  close() {
    this.closed = true
    try { if (this.sock) this.sock.destroy() } catch { /* ignore */ }
    this.sock = null
  }
}

class LauncherService extends Service {
  constructor(ctx, cfg = {}) {
    super(ctx, 'launcher')
    this.cfg = cfg || {}
    this.child = null
    this.rpc = null
    this.token = ''
    this.media = ''
    this.position = 0
    this.paused = false
    this.conn = false
    this.lastError = ''
    this._poll = null
    this._fd = null
    this._wantUrl = ''
    this._openTry = 0

    ctx.on('dispose', () => { this.launchStop().catch(() => {}) })
  }

  exePath() {
    return this.cfg.exe || process.env.PP_EXE || DEFAULT_EXE
  }

  /** 快捷入口 RPC 端口（与 radio 应用的监听/入口区分），env PP_LAUNCH_PORT 可覆盖。 */
  launchPort() {
    return Number(this.cfg.launchPort || process.env.PP_LAUNCH_PORT || 7921)
  }

  status() {
    return {
      enabled: true,
      running: !!(this.child && !this.child.killed),
      pid: this.child ? this.child.pid : null,
      connected: this.conn,
      exe: this.exePath(),
      exe_exists: fs.existsSync(this.exePath()),
      rpc_port: this.launchPort(),
      media: this.media,
      position: Number((this.position || 0).toFixed(2)),
      paused: this.paused,
      last_error: this.lastError,
    }
  }

  /** 前台拉起 PluginPlayer（可见窗口）。url 可选：给出则启动后即打开该媒体。 */
  async launchStart(url) {
    if (this.child && !this.child.killed) {
      if (url) await this._open(url)
      return this.status()
    }
    const exe = this.exePath()
    if (!fs.existsSync(exe)) {
      this.lastError = '播放器不存在: ' + exe + '（用 cordis.yml plugins.launcher.exe 指定）'
      this.ctx.logger.warn('[launcher] ' + this.lastError)
      return this.status()
    }
    this.token = this.cfg.token || crypto.randomBytes(16).toString('hex')  // ≥16 字符（内核校验）
    const port = this.launchPort()
    // 无 --hidden → 可见窗口（与 radio 监听的 windowsHide:true 相反）；
    // --allow-network-input → 允许打开网络流 / 远程文件。
    const args = ['--allow-network-input', '--rpc-port', String(port), '--rpc-token', this.token]
    if (url) args.push(String(url))

    this.ctx.logger.info('[launcher] 拉起播放器(前台): ' + exe + ' ' + args.slice(0, 4).join(' '))
    const logDir = path.join(this.ctx.config.root || '.', 'data', 'logs')
    let fd = null
    try {
      fs.mkdirSync(logDir, { recursive: true })
      fd = fs.openSync(path.join(logDir, 'launcher-player.log'), 'a')
    } catch { /* 目录不可写就退回丢弃输出 */ }
    this._fd = fd
    this.child = spawn(exe, args, {
      cwd: path.dirname(exe),
      stdio: ['ignore', fd || 'ignore', fd || 'ignore'],
      windowsHide: false, // 关键：显示播放器窗口
    })
    this.child.on('error', (e) => {
      this.lastError = '启动失败: ' + (e && e.message)
      this.ctx.logger.warn('[launcher] ' + this.lastError)
    })
    this.child.on('exit', (code) => {
      this.ctx.logger.info('[launcher] 播放器已退出 code=' + code)
      if (this._fd != null) { try { fs.closeSync(this._fd) } catch { /* ignore */ }; this._fd = null }
      this.child = null
      this.conn = false
      this.rpc = null
      this.media = ''
      this.position = 0
      this.paused = false
      this._wantUrl = ''
      this._stopPoll()
    })

    try {
      await this._connectWithRetry(port, 12000)
      this.conn = true
      this.lastError = ''
      this._startPoll()
      if (url) {
        await this._open(url)
        if (!this.media && this.lastError) this._wantUrl = url // 冷源：交给轮询重试
      }
    } catch (e) {
      this.lastError = '控制通道未就绪: ' + (e && e.message)
      this.ctx.logger.warn('[launcher] ' + this.lastError)
    }
    return this.status()
  }

  async _connectWithRetry(port, totalMs) {
    const deadline = Date.now() + totalMs
    let lastErr = null
    while (Date.now() < deadline) {
      if (!this.child || this.child.killed) throw new Error('播放器进程已退出')
      try {
        this.rpc = new Rpc(port, this.token)
        await this.rpc.connect(4000)
        return
      } catch (e) {
        lastErr = e
        if (this.rpc) { this.rpc.close(); this.rpc = null }
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw lastErr || new Error('未知错误')
  }

  async launchStop() {
    this._stopPoll()
    const child = this.child
    if (!child || child.killed) { this.conn = false; this.child = null; return this.status() }
    try { if (this.rpc && this.conn) await this.rpc.call('app.quit', {}, 3000).catch(() => {}) } catch { /* ignore */ }
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 6000)
      child.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    if (!exited) { try { child.kill() } catch { /* ignore */ }; this.ctx.logger.info('[launcher] 6 秒未退出，已强制结束') }
    if (this.rpc) { this.rpc.close(); this.rpc = null }
    this.child = null
    this.conn = false
    this.media = ''
    this.position = 0
    this.paused = false
    this._wantUrl = ''
    return this.status()
  }

  async _open(url) {
    if (!this.rpc || !this.conn) return
    try {
      await this.rpc.call('player.open', { path: String(url) }, 20000)
      this.media = String(url)
      this.lastError = ''
      this.ctx.logger.info('[launcher] 已打开 ' + url)
    } catch (e) {
      this.lastError = '打开失败: ' + (e && e.message)
      this.media = '' // 清空让轮询重试逻辑接手（冷源首开可能失败）
      this.ctx.logger.warn('[launcher] ' + this.lastError)
    }
  }

  /** 控制通道驱动：action ∈ open|play|pause|stop|seek。 */
  async launchControl(action, params = {}) {
    if (!this.rpc || !this.conn) return this.status()
    const map = { open: 'player.open', play: 'player.play', pause: 'player.pause', stop: 'player.stop', seek: 'player.seek' }
    const method = map[action]
    if (!method) return this.status()
    const p = {}
    if (action === 'open') p.path = String(params.path || '')
    if (action === 'seek') p.seconds = Number(params.pos || 0)
    try {
      await this.rpc.call(method, p, 5000)
      if (action === 'open') this.media = p.path
      if (action === 'stop') this.media = ''
      this.lastError = ''
    } catch (e) {
      this.lastError = action + ' 失败: ' + (e && e.message)
    }
    return this.status()
  }

  _startPoll() {
    if (this._poll) return
    this._poll = setInterval(async () => {
      if (!this.rpc || !this.conn) return
      try {
        const st = await this.rpc.call('player.stats', {}, 3000)
        if (st) { this.position = st.position || 0; this.paused = !!st.paused }
      } catch {
        this.conn = false
        this.lastError = '控制通道失联'
        return
      }
      // 冷源首开未成功 → 每 3s 重试一次
      if (this._wantUrl && !this.media) {
        const now = Date.now()
        if (now - (this._openTry || 0) > 3000) {
          this._openTry = now
          await this._open(this._wantUrl)
        }
      }
    }, 2000)
  }

  _stopPoll() {
    if (this._poll) { clearInterval(this._poll); this._poll = null }
  }
}

LauncherService.inject = ['config']

export default function launcherPlugin(ctx, cfg = {}) {
  ctx.plugin(LauncherService, cfg)
}
