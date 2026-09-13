// monitor plugin — 本机监听（P3，2026-09-13）
// ---------------------------------------------------------------------------
// 把 PluginPlayer（G:\local\pluginplayer）当作**本机收听端**拉起来听本服务的转播：
//
//   · 进程：pluginplayer.exe --hidden --allow-network-input --rpc-port <port> --rpc-token <token>
//   · 控制：127.0.0.1:<port> 换行分隔 JSON（首条必须是 auth），驱动
//           player.open / player.stats / player.stop / app.quit
//   · 跟随：relay:start → 自动打开本服务 /stream；relay:stop → 自动停
//
// 为什么不用 dist/config/rpc-token.txt：pluginplayer 允许 --rpc-token 自带令牌，
// 而令牌文件是"每次启动覆盖同一个文件"的（内核注释明确警告多实例会互相顶掉）。
// 自带令牌既避免读文件竞态，也不影响用户手动启动的其它实例。
//
// 契约：GET /api/monitor；POST /api/monitor/start {mount?}；POST /api/monitor/stop
import { Service } from 'cordis'
import { spawn } from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_EXE = 'G:\\local\\pluginplayer\\dist\\pluginplayer.exe'

/** 控制通道客户端：换行分隔 JSON over TCP（协议见 src/core/control.h）。 */
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
        // 注意：call() 解析出的是**应答的 result 字段**，不是整包。
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

class MonitorService extends Service {
  constructor(ctx, cfg = {}) {
    super(ctx, 'monitor')
    this.cfg = cfg || {}
    this.child = null
    this.rpc = null
    this.token = ''
    // 默认 hls：实测 /stream 的每个客户端都会新起一次 ffmpeg 冷拉源（首帧 5-15s），
    // 播放器探测超时必然失败；HLS 走 radio 自己的热切片，冷开首次失败后重试即成功。
    this.mount = this.cfg.mount || 'hls'
    this.lastError = ''
    this.connected = false
    this.position = 0
    this.paused = false
    this.mediaPath = ''
    this._pollTimer = null
    this._bound = false

    ctx.on('dispose', () => { this.stop().catch(() => {}) })
    ctx.on('relay:start', () => { this._onRelayStart() })
    ctx.on('relay:stop', () => { this._onRelayStop() })
  }

  exePath() {
    return this.cfg.exe || process.env.PP_EXE || DEFAULT_EXE
  }

  rpcPort() {
    return Number(this.cfg.port || process.env.PP_RPC_PORT || 7911)
  }

  /** 本服务自己的流地址（播放器与本服务同机，走 loopback）。 */
  streamUrl(mount) {
    const m = mount || this.mount || 'stream'
    const port = this.ctx.config && this.ctx.config.port ? this.ctx.config.port : 8000
    if (m === 'hls') return `http://127.0.0.1:${port}/hls/live.m3u8`
    if (m === 'stream') return `http://127.0.0.1:${port}/stream`
    return `http://127.0.0.1:${port}/stream/${m}`
  }

  status() {
    return {
      running: !!(this.child && !this.child.killed),
      pid: this.child ? this.child.pid : null,
      connected: this.connected,
      exe: this.exePath(),
      exe_exists: fs.existsSync(this.exePath()),
      rpc_port: this.rpcPort(),
      mount: this.mount,
      url: this.streamUrl(),
      media: this.mediaPath,
      position: Number((this.position || 0).toFixed(2)),
      paused: this.paused,
      last_error: this.lastError,
    }
  }

  async start(mount) {
    if (mount) this.mount = String(mount)
    if (this.child && !this.child.killed) {
      // 已运行：切挂载点/恢复播放即可
      if (this.ctx.station && this.ctx.station.mode === 'relay') await this._openStream()
      return this.status()
    }
    const exe = this.exePath()
    if (!fs.existsSync(exe)) {
      this.lastError = '播放器不存在: ' + exe + '（用 cordis.yml plugins.monitor.exe 指定）'
      this.ctx.logger.warn('[monitor] ' + this.lastError)
      return this.status()
    }
    this.token = this.cfg.token || crypto.randomBytes(16).toString('hex')  // ≥16 字符（内核校验）
    const port = this.rpcPort()
    const args = ['--hidden', '--allow-network-input', '--rpc-port', String(port), '--rpc-token', this.token]
    if (this.ctx.station && this.ctx.station.mode === 'relay') args.push(this.streamUrl())

    this.ctx.logger.info('[monitor] 启动播放器: ' + exe + ' ' + args.slice(0, 5).join(' '))
    // 播放器输出落盘（data/logs/monitor-player.log）：无窗口运行时唯一的排障依据
    let fd = null
    try {
      const logDir = path.join(this.ctx.config.root || '.', 'data', 'logs')
      fs.mkdirSync(logDir, { recursive: true })
      fd = fs.openSync(path.join(logDir, 'monitor-player.log'), 'a')
    } catch { /* 目录不可写就退回丢弃输出 */ }
    this.child = spawn(exe, args, {
      cwd: path.dirname(exe),
      stdio: ['ignore', fd || 'ignore', fd || 'ignore'],
      windowsHide: true,
    })
    this._logFd = fd
    this.child.on('error', (e) => {
      this.lastError = '启动失败: ' + (e && e.message)
      this.ctx.logger.warn('[monitor] ' + this.lastError)
    })
    this.child.on('exit', (code) => {
      this.ctx.logger.info('[monitor] 播放器已退出 code=' + code)
      if (this._logFd !== null && this._logFd !== undefined) {
        try { fs.closeSync(this._logFd) } catch { /* ignore */ }
        this._logFd = null
      }
      this.child = null
      this.connected = false
      this.rpc = null
      this._stopPoll()
    })

    // 等控制通道起来并认证（播放器启动约 1-2s，这里给足 12s）
    try {
      await this._connectWithRetry(port, 12000)
      this.connected = true
      this.lastError = ''
      this._startPoll()
      if (this.ctx.station && this.ctx.station.mode === 'relay') await this._openStream()
    } catch (e) {
      this.lastError = '控制通道未就绪: ' + (e && e.message)
      this.ctx.logger.warn('[monitor] ' + this.lastError)
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

  async stop() {
    this._stopPoll()
    const child = this.child
    if (!child || child.killed) { this.connected = false; return this.status() }
    // 优雅退出：RPC app.quit（P0 修复后约 2s 内退出）
    try {
      if (this.rpc && this.connected) await this.rpc.call('app.quit', {}, 3000).catch(() => {})
    } catch { /* ignore */ }
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 6000)
      child.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    if (!exited) {
      try { child.kill() } catch { /* ignore */ }
      this.ctx.logger.info('[monitor] 6 秒未退出，已强制结束播放器')
    }
    if (this.rpc) { this.rpc.close(); this.rpc = null }
    this.child = null
    this.connected = false
    this.mediaPath = ''
    this.position = 0
    return this.status()
  }

  async _openStream() {
    if (!this.rpc || !this.connected) return
    const url = this.streamUrl()
    try {
      // 冷开可能要等源出数据，超时放宽到 20s（超时只影响本次，重试仍会继续）
      await this.rpc.call('player.open', { path: url }, 20000)
      this.mediaPath = url
      this.lastError = ''
      this.ctx.logger.info('[monitor] 已让播放器打开 ' + url)
    } catch (e) {
      this.lastError = '打开流失败: ' + (e && e.message)
      // 清空 mediaPath 让 2s 轮询的重试逻辑接手（转播刚恢复时 HLS 切片还没生成，
      // 首次 open 必然失败；不清空就会一直以为"已经开着"而不再重试）
      this.mediaPath = ''
      this.ctx.logger.warn('[monitor] ' + this.lastError)
    }
  }

  _onRelayStart() {
    if (!this.child || this.child.killed) return
    this._openStream()
  }

  _onRelayStop() {
    if (!this.rpc || !this.connected) return
    this.mediaPath = ''      // 流已停：下次 relay:start 会重新打开
    this.rpc.call('player.stop', {}, 4000).catch(() => {})
  }

  _startPoll() {
    if (this._pollTimer) return
    this._pollTimer = setInterval(async () => {
      if (!this.rpc || !this.connected) return
      try {
        const st = await this.rpc.call('player.stats', {}, 3000)
        if (st) {
          this.position = st.position || 0
          this.paused = !!st.paused
        }
      } catch {
        this.connected = false
        this.lastError = '控制通道失联'
        return
      }
      // 转播中但还没打开流 → 重试（用户常在转播刚启动时就点监听，
      // 此时 ffmpeg 可能还在拉源、/stream 尚未出数据，open 会失败）。
      if (this.ctx.station && this.ctx.station.mode === 'relay' && !this.mediaPath) {
        const now = Date.now()
        if (now - (this._lastOpenTry || 0) > 3000) {
          this._lastOpenTry = now
          await this._openStream()
        }
      }
    }, 2000)
  }

  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
  }
}

MonitorService.inject = ['config', 'station']

export default function monitorPlugin(ctx, cfg = {}) {
  ctx.plugin(MonitorService, cfg)
}
