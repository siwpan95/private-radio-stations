// station plugin — 核心状态机在 @relay/core/station-base，这里只扩展 status()。
import { StationBase } from '@relay/core/src/station-base.js'

class StationService extends StationBase {
  constructor(ctx) {
    super(ctx, 'station')
  }

  status() {
    const s = super.status()
    const cfg = this.ctx.config || {}
    return {
      ...s,
      hls_url: cfg.hls && cfg.hls.enabled ? '/hls/live.m3u8' : null,
      hls_variants: (cfg.hls && cfg.hls.variants) || [],
      mounts: cfg.transcodeMounts || [],
    }
  }
}

StationService.inject = [...StationBase.inject]

export default function stationPlugin(ctx) {
  ctx.plugin(StationService)
}