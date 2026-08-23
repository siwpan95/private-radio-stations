// mediamtx plugin — 托管 MediaMTX 进程（启动 / 退出守护 / 崩溃自动重启），
// 并通过对 :9997 控制 API 的健康探测，把"路径是否有读者/发布者"暴露给面板。
import { Service } from 'cordis'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const STDRING = 30          // stderr 环形缓冲行数（供面板排查）
const MAX_RESTARTS = 5      // 60 秒内最多自动重启次数

class MediamtxService extends Service {
  constructor(ctx) {
    super(ctx, 'mediamtx')
    this.child = null
    this.restarts = 0
    this.restartWindow = 0
    this.lastError = null
    this.disposed = false
    this.stderrTail = []
    this.startedAt = null
    ctx.on('ready', () => this.start())
    ctx.on('dispose', () => {
      this.disposed = true
      this.stop()
    })
    // 兜底：任何正常退出路径都确保杀掉子进程（崩溃/强制退出时由系统回收）
    process.on('exit', () => this.stop())
  }

  get exe() {
    return this.ctx.config.mediamtxExe
  }

  start() {
    if (!this.exe) {
      this.ctx.logger.error('mediamtx.exe 未找到 — 无法本地分发（期望 mediamtx/mediamtx.exe）')
      return
    }
    if (this.child) return
    // mediamtx.yml 里 logFile: data/logs/mediamtx.log，确保目录存在
    try {
      fs.mkdirSync(path.resolve(this.ctx.config.root, 'data', 'logs'), { recursive: true })
    } catch { /* ignore */ }
    const yml = this.ctx.config.mediamtx.yml
    const child = spawn(this.exe, [yml], {
      cwd: this.ctx.config.root,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.startedAt = Date.now()
    child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDRING) this.stderrTail.shift()
      }
    })
    child.on('error', (e) => {
      this.lastError = e.message
      this.ctx.logger.error('mediamtx 启动失败: ' + e.message)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      const ranSec = Math.round((Date.now() - this.startedAt) / 1000)
      this.ctx.logger.warn(`mediamtx exited (code=${code} signal=${signal}, ran ${ranSec}s)`)
      // 把 stderr 尾巴写进主日志，便于排障（端口占用等）
      if (this.stderrTail.length) {
        this.ctx.logger.error('mediamtx 退出前日志：\n' + this.stderrTail.slice(-10).join('\n'))
      }
      if (this.disposed) return
      // 短命进程 = 配置/端口问题，自动重启有限次
      const now = Date.now()
      if (now - this.restartWindow > 60000) this.restarts = 0
      this.restartWindow = now
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1
        const delay = 2000 * this.restarts
        this.ctx.logger.warn(`mediamtx ${delay / 1000}s 后自动重启（第 ${this.restarts}/${MAX_RESTARTS} 次）`)
        setTimeout(() => {
          if (!this.disposed && !this.child) this.start()
        }, delay)
      } else {
        this.ctx.logger.error('mediamtx 反复崩溃，已停止自动重启（常见原因：端口被占用，检查 8554/8888/8889/9997）')
      }
    })
    this.ctx.logger.info('mediamtx starting (rtsp :8554, hls :8888, webrtc :8889, api :9997)')
  }

  stop() {
    if (this.child) {
      try { this.child.kill('SIGKILL') } catch { /* ignore */ }
      this.child = null
    }
  }

  // 健康探测：控制 API 查 /v3/paths/get/<pathName>
  async status() {
    const { apiAddress } = this.ctx.config.mediamtx
    const pathName = this.ctx.config.pathName
    let api = null
    try {
      const resp = await fetch(`http://${apiAddress}/v3/paths/get/${encodeURIComponent(pathName)}`, {
        signal: AbortSignal.timeout(2000),
      })
      if (resp.ok) {
        let p = await resp.json()
        if (p && p.item) p = p.item
        api = {
          ready: !!p.ready,
          readers: Array.isArray(p.readers) ? p.readers.length : 0,
          tracks: p.tracks ? Object.keys(p.tracks).length : 0,
          bytesReceived: p.bytesReceived || 0,
        }
      }
    } catch {
      /* api 不可达：mediamtx 未就绪 */
    }
    return {
      running: !!this.child,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastError: this.lastError,
      api,
      stderrTail: this.stderrTail.slice(),
    }
  }
}

MediamtxService.inject = ['config']

export default function mediamtxPlugin(ctx) {
  ctx.plugin(MediamtxService)
}
