// station plugin — 核心状态机在 @relay/core/station-base，这里扩展 status() 与 musickit 音源模式（S4b）。
import { StationBase } from '@relay/core/src/station-base.js'

class StationService extends StationBase {
  constructor(ctx) {
    super(ctx, 'station')
    this._musickit = false
    this._musickitTimer = null
  }

  status() {
    const s = super.status()
    const cfg = this.ctx.config || {}
    return {
      ...s,
      hls_url: cfg.hls && cfg.hls.enabled ? '/hls/live.m3u8' : null,
      hls_variants: (cfg.hls && cfg.hls.variants) || [],
      mounts: cfg.transcodeMounts || [],
      musickit: this._musickit,
    }
  }

  // ---- musickit 音源模式（S4b：自 python broadcaster mode==='musickit' 迁移） ----
  // 播放循环：musickit 队列取曲 → setRelay(本地文件) → 曲目结束(web pipeChild exit 0) → advanceMusickitTrack()。
  playMusickit(channel, bars) {
    const m = this.ctx.musickit
    if (!m) { this.error = 'musickit 插件未启用'; return false }
    m.start(channel, bars)
    this._musickit = true
    const ok = this._advanceMusickit()
    if (!ok) {
      // 队列暂无就绪曲目：等待渲染，定时重试取曲
      this.error = 'musickit 渲染队列等待中（首曲约 15-60 秒）'
      this.ctx.logger.info(this.error)
      this._ensureMusickitTimer()
    }
    return true
  }

  _ensureMusickitTimer() {
    if (this._musickitTimer) return
    this._musickitTimer = setInterval(() => {
      if (!this._musickit) return
      if (this.mode === 'relay' && this.current) return // 已有曲目在播，等结束事件
      this._advanceMusickit()
    }, 5000)
  }

  _advanceMusickit() {
    if (!this._musickit) return false
    const meta = this.ctx.musickit && this.ctx.musickit.advance()
    if (!meta || !meta.file) return false
    this.setRelay(meta.file, meta.title || meta.file)
    return true
  }

  advanceMusickitTrack() {
    if (!this._musickit) return
    const ok = this._advanceMusickit()
    if (!ok) {
      // 队列空：等渲染（定时器继续重试）
      this.ctx.logger.info('musickit 队列暂无下一曲，等待渲染')
      this._ensureMusickitTimer()
    }
  }

  stopMusickit() {
    this._musickit = false
    if (this._musickitTimer) { clearInterval(this._musickitTimer); this._musickitTimer = null }
    if (this.ctx.musickit) this.ctx.musickit.stop()
    this.stopRelay()
  }
}

// musickit 音源模式要访问 ctx.musickit；cordis 不允许取未 inject 的服务
// （报 cannot get property "musickit" without inject），因此显式声明依赖。
// 对应地 cordis.yml 里 musickit 行必须排在 station 之前。
StationService.inject = [...StationBase.inject, 'musickit']

export default function stationPlugin(ctx) {
  ctx.plugin(StationService)
}
