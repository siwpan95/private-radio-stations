// recorder plugin — 录像：从本地 MediaMTX RTSP 拉流落盘（recordings/*.ts）。
// 随转播自动启停（当 relay 请求带 record=true），也可由面板独立开关。
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

class RecorderService extends Service {
  constructor(ctx) {
    super(ctx, 'recorder')
    this.child = null
    this.file = null
    this.startedAt = null
    this.lastError = null
    this.retries = 0
    this.disposed = false
    this.stopping = false
    ctx.on('relay:start', (cur) => {
      if (cur.record) this.start()
    })
    ctx.on('relay:stop', () => this.stop())
    ctx.on('dispose', () => {
      this.disposed = true
      this.stop()
    })
  }

  get dir() {
    const d = path.resolve(this.ctx.config.root, this.ctx.config.record.dir)
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
    return d
  }

  start() {
    if (this.child || this.ctx.station.mode !== 'relay') return
    const ff = this.ctx.config.ffmpeg
    if (!ff) {
      this.ctx.logger.error('录像失败：ffmpeg not found')
      return
    }
    const name = String(this.ctx.station.current?.name || 'stream')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 40)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = path.join(this.dir, `${name}_${ts}.ts`)
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', `rtsp://127.0.0.1:${this.ctx.config.rtspPort}/${this.ctx.config.pathName}`,
      '-c:v', 'copy', // 视频原样；音频统一转 AAC 保证 TS 兼容
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'mpegts',
      '-y', file,
    ]
    const child = spawn(ff, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    this.child = child
    this.file = file
    this.startedAt = Date.now()
    this.lastError = null
    this.retries = 0
    this.stopping = false
    this.ctx.logger.info('recording start -> ' + file)
    child.on('error', (e) => {
      this.lastError = e.message
      this.ctx.logger.error('recording spawn error: ' + e.message)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.ctx.logger.info(
        `recording stopped (${this.file})\n  code=${code} signal=${signal}`
      )
      // 早期退出（RTSP 尚未就绪等）且仍在转播：自动重试几次
      const ranSec = Math.round((Date.now() - this.startedAt) / 1000)
      if (!this.stopping && !this.disposed && this.ctx.station.mode === 'relay' && ranSec < 10 && this.retries < 5) {
        this.retries += 1
        this.ctx.logger.warn(`recording early exit, retry ${this.retries}/5 in 3s`)
        setTimeout(() => {
          if (!this.disposed && this.ctx.station.mode === 'relay' && !this.child) this.start()
        }, 3000)
      }
    })
  }

  stop() {
    this.stopping = true // 主动停止不触发 exit 重试
    if (this.child) {
      try { this.child.kill('SIGKILL') } catch { /* ignore */ }
      this.child = null
    }
  }

  status() {
    let bytes = 0
    if (this.file) {
      try { bytes = fs.statSync(this.file).size } catch { /* ignore */ }
    }
    return {
      running: !!this.child,
      file: this.file,
      startedAt: this.startedAt,
      bytes,
      lastError: this.lastError,
    }
  }

  list() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.ts') || f.endsWith('.mp4') || f.endsWith('.mkv'))
        .map((f) => {
          const s = fs.statSync(path.join(this.dir, f))
          return { name: f, size: s.size, mtimeMs: s.mtimeMs }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    } catch {
      return []
    }
  }

  remove(name) {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false
    const f = path.join(this.dir, name)
    if (!f.startsWith(this.dir)) return false
    try {
      fs.rmSync(f, { force: true })
      return true
    } catch {
      return false
    }
  }
}

RecorderService.inject = ['config', 'station']

export default function recorderPlugin(ctx) {
  ctx.plugin(RecorderService)
}
