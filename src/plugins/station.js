// station plugin — relay state machine (idle <-> relay) with automatic
// multi-source failover and same-source retry with backoff.
// Holds no subprocesses; streamer/recorder listen to its lifecycle events.
import { Service } from 'cordis'

class StationService extends Service {
  constructor(ctx) {
    super(ctx, 'station')
    this.mode = 'idle'
    this.current = null // { url, name, transcode, record }
    this.sources = [] // [primary, ...fallbacks] with current first
    this.failureCount = 0
    this.maxFailures = 3
    this.error = null
    this.startedAt = null
  }

  setRelay(url, name, fallbacks = [], opts = {}) {
    if (!url) return
    const primary = {
      url,
      name: name || url,
      transcode: opts.transcode === true,
      record: opts.record === true,
    }
    const extras = (fallbacks || [])
      .filter(Boolean)
      .map((u) => ({ url: u, name: u, transcode: primary.transcode, record: primary.record }))
    this.sources = [primary, ...extras]
    this.current = this.sources[0]
    this.failureCount = 0
    this.error = null
    this.mode = 'relay'
    this.startedAt = Date.now()
    // 拦截点（cordis waterfall）：其它插件可在此否决或改写开播
    let veto = false
    try { veto = this.ctx.waterfall('relay:pre-start', this.current) === false } catch (e) {
      this.ctx.logger.error('relay:pre-start 监听器异常: ' + e)
    }
    if (veto) {
      this.error = '转播被插件拦截（relay:pre-start 返回 false）'
      this.mode = 'idle'
      this.current = null
      this.startedAt = null
      this.ctx.logger.warn(this.error)
      return
    }
    this.ctx.emit('relay:start', this.current)
    this.ctx.logger.info(`relay start: ${this.current.name} (${this.current.url})`)
  }

  stopRelay() {
    if (this.mode === 'idle') return
    this.mode = 'idle'
    this.current = null
    this.sources = []
    this.failureCount = 0
    this.error = null
    this.startedAt = null
    this.ctx.emit('relay:stop')
    this.ctx.logger.info('relay stopped')
  }

  // ffmpeg 拉流短命退出：先原地重试，超过上限则切换备用源；
  // 没有备用源则停下自动重试并给出错误提示（可手动再点开始）。
  noteFailure() {
    this.failureCount += 1
    if (this.failureCount >= this.maxFailures && this.sources.length > 1) {
      this._advance()
      return
    }
    if (this.failureCount >= this.maxFailures) {
      this.error = '连续 ' + this.maxFailures + ' 次拉流失败，已停止自动重试（检查源地址或网络后点"开始转播"重试）'
      this.ctx.logger.error(this.error)
      return
    }
    this.ctx.emit('relay:retry', this.current)
    this.ctx.logger.warn(
      `relay failed (${this.failureCount}/${this.maxFailures}), retrying same source in a few seconds`
    )
  }

  // 正常播完（如点播视频到结尾），不算失败，不切换
  noteEnded() {
    if (this.mode !== 'relay') return
    this.error = '源播放结束（点播流已到结尾）'
    this.ctx.logger.info('relay source ended normally')
  }

  _advance() {
    this.sources.push(this.sources.shift())
    this.current = this.sources[0]
    this.failureCount = 0
    this.error = null
    this.ctx.emit('relay:source', this.current)
    this.ctx.logger.warn(`failover -> ${this.current.name} (${this.current.url})`)
  }

  activeUrl() {
    return this.mode === 'relay' && this.current ? this.current.url : null
  }

  status() {
    const cfg = this.ctx.config || {}
    return {
      version: cfg.version || 'unknown',
      mode: this.mode,
      current: this.current,
      sourceCount: this.sources.length,
      failureCount: this.failureCount,
      error: this.error,
      startedAt: this.startedAt,
      pathName: cfg.pathName || 'live',
      defaultTranscode: !!cfg.transcode,
      defaultRecord: !!(cfg.record && cfg.record.enabled),
      ffmpeg: cfg.ffmpegOk ? cfg.ffmpegOk() : false,
      mediamtx: cfg.mediamtxOk ? cfg.mediamtxOk() : false,
    }
  }
}

StationService.inject = ['config']

export default function stationPlugin(ctx) {
  ctx.plugin(StationService)
}
