// @relay/core — 转播状态机基类（视频/音频应用共用）。
// 语义：idle <-> relay；多源 failover；同源重试；relay:pre-start waterfall 拦截；
// 生命周期事件：relay:start / relay:source / relay:retry / relay:stop。
// 平台源自动续播（2026-08-30）：源带 refreshInfo（{platform,room}）时，拉流退出
// 或到期前主动触发 refreshSource() 重解析换源；默认无此能力，各应用用子类覆写。
// 各应用用子类覆盖 status() 增加自己的健康字段。
import { Service } from 'cordis'

const REFRESH_LEAD_SEC = 30 // 主动续播提前量：到期前 30s 重解析换源

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
    this.refreshing = false // 重解析进行中（防重入）
    this.refreshCount = 0   // 本次转播累计续播次数
    this.refreshTimer = null // 主动续播定时器
  }

  setRelay(url, name, fallbacks = [], opts = {}) {
    if (!url) return
    const primary = {
      url,
      name: name || url,
      transcode: opts.transcode === true,
      record: opts.record === true,
    }
    // 平台源自动续播字段：仅带 refreshInfo 时附加（保持普通源载荷向后兼容）
    if (opts.refreshInfo) {
      primary.refreshInfo = opts.refreshInfo
      primary.expiresAt = typeof opts.expiresAt === 'number' ? opts.expiresAt : 0
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
    this.refreshing = false
    this.refreshCount = 0
    this._clearRefreshTimer()
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
    this._scheduleRefresh()
  }

  stopRelay() {
    if (this.mode === 'idle') return
    this.mode = 'idle'
    this.current = null
    this.sources = []
    this.failureCount = 0
    this.error = null
    this.startedAt = null
    this.refreshing = false
    this._clearRefreshTimer()
    this.ctx.emit('relay:stop')
    this._assert('relay:stop')
    this.ctx.logger.info('relay stopped')
  }

  // 拉流短命退出：先原地重试，超过上限切备用源；平台源无备用源时改走重解析
  noteFailure() {
    this.failureCount += 1
    if (this.failureCount >= this.maxFailures && this.sources.length > 1) {
      this._advance()
      return
    }
    if (this.failureCount >= this.maxFailures) {
      if (this.current && this.current.refreshInfo) {
        this.failureCount = 0
        this._refreshAndContinue('failures')
        return
      }
      this.error = '连续 ' + this.maxFailures + ' 次拉流失败，已停止自动重试（检查源地址或网络后点"开始转播"重试）'
      this.ctx.logger.error(this.error)
      return
    }
    this.ctx.emit('relay:retry', this.current)
    this.ctx.logger.warn(
      `relay failed (${this.failureCount}/${this.maxFailures}), retrying same source in a few seconds`
    )
  }

  // 长跑退出：点播 = 正常播完；平台源 = token 到期 → 重解析续播
  noteEnded() {
    if (this.mode !== 'relay') return
    if (this.current && this.current.refreshInfo) {
      this._refreshAndContinue('ended')
      return
    }
    this.error = '源播放结束（点播流已到结尾）'
    this.ctx.logger.info('relay source ended normally')
  }

  _advance() {
    this._clearRefreshTimer()
    this.sources.push(this.sources.shift())
    this.current = this.sources[0]
    this.failureCount = 0
    this.error = null
    this.ctx.emit('relay:source', this.current)
    this._assert('relay:source')
    this.ctx.logger.warn(`failover -> ${this.current.name} (${this.current.url})`)
    this._scheduleRefresh()
  }

  // ---- 平台源自动续播（2026-08-30）----
  // 扩展点：子类覆写后接入平台解析器；基类默认无能力（音频应用零影响）。
  // 返回 { url, expiresAt } 或 null（未开播/解析失败）。
  async refreshSource(_refreshInfo) {
    return null
  }

  async _refreshAndContinue(reason) {
    if (this.refreshing || this.mode !== 'relay') return
    const cur = this.current
    if (!cur || !cur.refreshInfo) return
    this.refreshing = true
    this.refreshCount += 1
    const tag = `${cur.refreshInfo.platform}/${cur.refreshInfo.room}`
    this.ctx.logger.info(`relay refresh #${this.refreshCount} (${reason}) ${tag}`)
    try {
      const r = await this.refreshSource(cur.refreshInfo)
      this.refreshing = false
      if (this.mode !== 'relay' || this.current !== cur) return
      if (r && typeof r.url === 'string' && r.url) {
        cur.url = r.url
        this.sources[0].url = r.url
        cur.expiresAt = typeof r.expiresAt === 'number' ? r.expiresAt : 0
        this.failureCount = 0
        this.error = null
        this.ctx.emit('relay:retry', cur) // streamer 收到后延迟重启（换新 URL）
        this._scheduleRefresh()
        this.ctx.logger.info(`relay re-resolved ok -> ${r.url}`)
      } else {
        this.error = '房间未开播或平台解析失败，已停止转播（重新点「开始转播」可重试）'
        this.ctx.logger.warn(this.error)
      }
    } catch (e) {
      this.refreshing = false
      this.error = '自动重解析异常：' + e.message
      this.ctx.logger.error(this.error)
    }
  }

  _scheduleRefresh() {
    this._clearRefreshTimer()
    const cur = this.current
    if (!cur || !cur.refreshInfo || !cur.expiresAt) return
    const fireAt = (cur.expiresAt - REFRESH_LEAD_SEC) * 1000
    const delayMs = Math.max(5000, fireAt - Date.now())
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.mode === 'relay' && this.current === cur) {
        this._refreshAndContinue('expiry')
      }
    }, delayMs)
    this.ctx.logger.info(
      `relay auto-refresh scheduled in ${Math.round(delayMs / 1000)}s (expiresAt=${cur.expiresAt})`
    )
  }

  _clearRefreshTimer() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
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
    inv.register('station.refreshCount 非负', () => {
      if (this.refreshCount < 0) throw new Error('refreshCount=' + this.refreshCount)
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

  // P8B 服务 dispose 约定：热卸载前停掉进行中的转播
  dispose() {
    this.stopRelay()
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
      refreshing: this.refreshing,
      refreshCount: this.refreshCount,
      refreshInfo: this.current && this.current.refreshInfo ? this.current.refreshInfo : null,
      expiresAt: this.current && this.current.expiresAt ? this.current.expiresAt : 0,
    }
  }
}

StationBase.inject = ['config', 'invariants']