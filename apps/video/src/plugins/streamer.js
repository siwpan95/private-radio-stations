// streamer plugin — spawns ffmpeg to pull the active source and push it to
// MediaMTX over RTSP (default -c copy; optional H.264 transcode). ffmpeg's own
// -reconnect network stack does the pulling (same robust path as the radio
// project). Failover/retry is driven by the station state machine.
import { Service } from 'cordis'
import { spawn } from 'node:child_process'

// ffmpeg 拉流参数助手来自 @relay/core（与音频应用共用）
import { resolveSource, needsReconnect, RECONNECT_ARGS } from '@relay/core/src/ffmpeg-args.js'

export { resolveSource, needsReconnect, RECONNECT_ARGS }

const STDRING = 80           // ffmpeg stderr 环形缓冲（供面板/日志排查）
const SHORT_RUN_SEC = 15     // 运行不足此时长即退出 => 视为拉流失败
const RETRY_DELAY_MS = 3000  // 原地重试等待（station 发 relay:retry 时）

class StreamerService extends Service {
  constructor(ctx) {
    super(ctx, 'streamer')
    this.child = null
    this.startedAt = null
    this.lastExit = null
    this.stderrTail = []
    this.retryTimer = null
    this.activeUrl = null
    this.disposed = false
    ctx.on('relay:start', (cur) => this.start(cur))
    ctx.on('relay:source', (cur) => this.start(cur)) // failover：立即换源
    ctx.on('relay:retry', (cur) => this.start(cur, RETRY_DELAY_MS)) // 原地重试：带延迟
    ctx.on('relay:stop', () => this.stop())
    ctx.on('dispose', () => {
      this.disposed = true
      this.stop()
    })
    process.on('exit', () => this.stop())
  }

  get station() {
    return this.ctx.station
  }

  async start(cur, delay = 0) {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const go = () => this._spawn(cur)
    if (delay > 0) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; go() }, delay)
      return
    }
    go()
  }

  async _spawn(cur) {
    this.stop()
    if (this.disposed || !cur || !cur.url) return
    const ff = this.ctx.config.ffmpeg
    if (!ff) {
      this.ctx.logger.error('ffmpeg not found — 无法拉流转播')
      return
    }
    let url = cur.url
    try {
      url = await resolveSource(cur.url)
    } catch {
      /* keep original */
    }
    this.activeUrl = url
    const pathName = this.ctx.config.pathName || 'live'
    const rtspTarget = `rtsp://127.0.0.1:${this.ctx.config.rtspPort}/${pathName}`
    const args = this.buildArgs(url, cur, rtspTarget)
    const child = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    const startedAt = Date.now()
    this.startedAt = startedAt
    this.lastExit = null
    this.stderrTail = []
    this.ctx.logger.info(
      `relay ffmpeg start (${cur.transcode ? 'transcode H.264' : 'copy'}) -> ${rtspTarget}\n  source: ${url}`
    )
    child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDRING) this.stderrTail.shift()
      }
    })
    child.on('error', (e) => {
      this.ctx.logger.error('relay ffmpeg spawn error: ' + e.message)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      const ranSec = Math.round((Date.now() - startedAt) / 1000)
      this.lastExit = {
        code, signal, ranSec,
        at: new Date().toISOString(),
        tail: this.stderrTail.slice(-8),
      }
      this.ctx.logger.warn(
        `relay ffmpeg exited (code=${code} signal=${signal}, ran ${ranSec}s)`
      )
      if (this.stderrTail.length) {
        this.ctx.logger.error('ffmpeg 退出前日志：\n' + this.stderrTail.slice(-10).join('\n'))
      }
      if (this.disposed || this.station.mode !== 'relay') return
      if (ranSec < SHORT_RUN_SEC) {
        this.station.noteFailure() // 触发原地重试或 failover
      } else {
        this.station.noteEnded() // 点播播完属正常结束
      }
    })
  }

  buildArgs(url, cur, rtspTarget) {
    const args = [
      ...(needsReconnect(url) ? RECONNECT_ARGS : []),
      '-fflags', '+nobuffer',
      '-flags', 'low_delay',
      '-rw_timeout', '10000000',
      '-i', url,
      '-map', '0:v:0',
      '-map', '0:a:0?',
    ]
    if (cur.transcode) {
      // 统一转成浏览器友好的 H.264 + AAC（兼容旧设备 / 网页播放）
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '2500k',
        '-maxrate', '3000k',
        '-bufsize', '6000k',
        '-pix_fmt', 'yuv420p',
        '-g', '50',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
      )
    } else {
      // 视频原样 copy；音频统一转 AAC：
      // HLS(MPEG-TS) 里的 AAC 没有 global headers，RTSP 封装器无法直接 copy
      args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000')
    }
    args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', rtspTarget)
    return args
  }

  // P8B 服务 dispose 约定：热卸载时停掉 ffmpeg 子进程
  dispose() {
    this.disposed = true
    this.stop()
  }

  stop() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.child) {
      try { this.child.kill('SIGKILL') } catch { /* ignore */ }
      this.child = null
    }
  }

  status() {
    return {
      running: !!this.child,
      startedAt: this.startedAt,
      activeUrl: this.activeUrl,
      lastExit: this.lastExit,
      stderrTail: this.stderrTail.slice(),
    }
  }
}

StreamerService.inject = ['config', 'station']

export default function streamerPlugin(ctx) {
  ctx.plugin(StreamerService)
}
