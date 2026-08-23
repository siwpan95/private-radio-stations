// @relay/core — 转播状态机基类（视频/音频应用共用）。
// 语义：idle <-> relay；多源 failover；同源重试；relay:pre-start waterfall 拦截；
// 生命周期事件：relay:start / relay:source / relay:retry / relay:stop。
// 各应用用子类覆盖 status() 增加自己的健康字段。
import { Service } from 'cordis'

export class StationBase extends Service {
  _registered = false
  _pairing = false // relay:start 与 relay:stop 配对追踪

  constructor(ctx, name = 'station') {
    super(ctx, name)
    this.mode = 'idle'
    this.current = null // { url, name, ...应用扩展字段 }
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
    this._assert('relay:start')
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
    this._assert('relay:stop')
    this.ctx.logger.info('relay stopped')
  }

  // 拉流短命退出：先原地重试，超过上限切备用源；无备用源则停重试并提示
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

  // 正常播完（点播到结尾），不算失败，不切换
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
    this._assert('relay:source')
    this.ctx.logger.warn(`failover -> ${this.current.name} (${this.current.url})`)
  }

  // ---- 运行时不变量（HARNESS P5）：事件配对 / 数据守恒 ----
  _ensureInvariants() {
    if (this._registered || !this.ctx.invariants) return
    this._registered = true
    const inv = this.ctx.invariants
    inv.register('station.mode 合法', () => ['idle', 'relay'].includes(this.mode))
    inv.register('station.relay 状态一致', () => {
      const inRelay = this.mode === 'relay'
      const hasCurrent = !!this.current && this.sources.length > 0
      if (inRelay !== hasCurrent) throw new Error('mode=' + this.mode + ' current=' + JSON.stringify(this.current) + ' sources=' + this.sources.length)
    })
    inv.register('station.FIFO 守恒', () => {
      if (this.current && this.sources.length && this.current !== this.sources[0]) {
        throw new Error('current 不是 sources[0]，切换源后队列被破坏')
      }
    })
    inv.register('station.failureCount 范围', () => {
      if (this.failureCount < 0 || this.failureCount > this.maxFailures) {
        throw new Error('failureCount=' + this.failureCount + ' 超出 [0,' + this.maxFailures + ']')
      }
    })
    inv.register('station.relay 事件配对', () => {
      if (this.mode === 'idle' && this._pairing) throw new Error('relay:stop 已发但配对标志未清')
    })
    this.ctx.on('relay:start', () => {
      if (this._pairing) this.ctx.logger.error('[INVARIANT] relay:start 重复触发（缺少 relay:stop）')
      this._pairing = true
    })
    this.ctx.on('relay:stop', () => { this._pairing = false })
  }

  _assert(tag) {
    try { this._ensureInvariants() } catch { /* 注册失败不阻塞 */ }
    if (this.ctx.invariants) this.ctx.invariants.run(tag)
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
      ffmpeg: cfg.ffmpegOk ? cfg.ffmpegOk() : false,
    }
  }
}

StationBase.inject = ['config', 'invariants']