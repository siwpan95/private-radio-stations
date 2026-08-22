// station plugin — relay state machine (idle <-> relay) with automatic
// multi-source failover. Holds no subprocesses; streamer/hls query it for the
// active source URL.
import { Service } from 'cordis'

class StationService extends Service {
  constructor(ctx) {
    super(ctx, 'station')
    this.mode = 'idle'
    this.current = null // { url, name }
    this.sources = [] // [{ url, name }, ...] with current first
    this.failureCount = 0
    this.maxFailures = 3
  }

  setRelay(url, name, fallbacks = []) {
    if (!url) return
    const primary = { url, name: name || url }
    const extras = (fallbacks || [])
      .filter(Boolean)
      .map((u) => ({ url: u, name: u }))
    this.sources = [primary, ...extras]
    this.current = this.sources[0]
    this.failureCount = 0
    this.mode = 'relay'
    this.ctx.emit('relay:start', this.current)
    this.ctx.logger.info(`relay start: ${this.current.name} (${this.current.url})`)
  }

  stopRelay() {
    if (this.mode === 'idle') return
    this.mode = 'idle'
    this.current = null
    this.sources = []
    this.failureCount = 0
    this.ctx.emit('relay:stop')
    this.ctx.logger.info('relay stopped')
  }

  noteFailure() {
    this.failureCount += 1
    if (this.failureCount >= this.maxFailures && this.sources.length > 1) {
      this._advance()
    }
  }

  _advance() {
    this.sources.push(this.sources.shift())
    this.current = this.sources[0]
    this.failureCount = 0
    this.ctx.emit('relay:source', this.current)
    this.ctx.logger.warn(`failover -> ${this.current.name} (${this.current.url})`)
  }

  activeUrl() {
    return this.mode === 'relay' && this.current ? this.current.url : null
  }

  status() {
    const cfg = this.ctx.config || {}
    return {
      mode: this.mode,
      current: this.current,
      sourceCount: this.sources.length,
      failureCount: this.failureCount,
      hls_url: cfg.hls && cfg.hls.enabled ? '/hls/live.m3u8' : null,
      mounts: cfg.transcodeMounts || [],
      ffmpeg: cfg.ffmpegOk ? cfg.ffmpegOk() : false,
    }
  }
}

StationService.inject = ['config']

export default function stationPlugin(ctx) {
  ctx.plugin(StationService)
}
