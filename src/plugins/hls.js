// hls plugin — slices the active relay source into HLS segments via ffmpeg,
// driven by the station lifecycle. Serves live.m3u8 + .ts into hls/<dir>.
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveSource, needsReconnect, RECONNECT_ARGS } from './streamer.js'

class HlsService extends Service {
  constructor(ctx) {
    super(ctx, 'hls')
    this.child = null
    this.dir = null
    // Wire lifecycle. Listeners don't touch ctx.config, so they are safe here.
    ctx.on('relay:start', (cur) => this.start(cur.url))
    ctx.on('relay:source', (cur) => this.start(cur.url))
    ctx.on('relay:stop', () => this.stop())
    ctx.on('dispose', () => this.stop())
  }

  get hlsDir() {
    if (!this.dir) {
      this.dir = path.resolve(this.ctx.config.root, this.ctx.config.hls.dir)
      fs.mkdirSync(this.dir, { recursive: true })
    }
    return this.dir
  }

  ffmpegOk() {
    return !!(this.ctx.config && this.ctx.config.ffmpeg)
  }

  start(url) {
    if (!url || !this.ffmpegOk()) return
    this.stop()
    const ff = this.ctx.config.ffmpeg
    const { segmentSec, listSize, bitrate } = this.ctx.config.hls
    resolveSource(url)
      .then((resolved) => this._spawn(ff, resolved, { segmentSec, listSize, bitrate }))
      .catch((e) => this.ctx.logger.warn(`hls resolve failed: ${e && e.message}`))
  }

  _spawn(ff, url, { segmentSec, listSize, bitrate }) {
    if (!url) return
    const args = [
      ...(needsReconnect(url) ? RECONNECT_ARGS : []),
      '-i', url,
      '-c:a', 'aac',
      '-b:a', `${bitrate}k`,
      '-f', 'hls',
      '-hls_time', String(segmentSec),
      '-hls_list_size', String(listSize),
      '-hls_flags', 'delete_segments+append_list',
      path.join(this.hlsDir, 'live.m3u8'),
    ]
    this.child = spawn(ff, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    this.child.on('exit', () => { if (this.child && this.child.exitCode !== null) this.child = null })
    this.ctx.logger.info(`hls start (${url}) -> ${this.hlsDir}/live.m3u8`)
  }

  stop() {
    if (this.child) {
      try { this.child.kill('SIGKILL') } catch { /* ignore */ }
      this.child = null
    }
    // Remove stale segments so an idle server never serves old audio.
    try {
      const dir = this.hlsDir
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.ts') || f === 'live.m3u8') {
          fs.rmSync(path.join(dir, f), { force: true })
        }
      }
    } catch { /* ignore */ }
  }
}

HlsService.inject = ['config', 'station']

export default function hlsPlugin(ctx) {
  ctx.plugin(HlsService)
}
