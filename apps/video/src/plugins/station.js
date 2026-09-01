// station 插件：核心状态机在 @relay/core/station-base，这里只扩展 status() 健康字段，
// 并覆写 refreshSource() 接入平台解析器（自动续播）。
import { StationBase } from '@relay/core/src/station-base.js'

class StationService extends StationBase {
  constructor(ctx) {
    super(ctx, 'station')
  }

  // 平台源到期/断流时由基类调用：重解析换新直链（含新时效）
  async refreshSource(refreshInfo) {
    const resolver = this.ctx.resolver
    if (!resolver || !refreshInfo) return null
    const r = await resolver.resolve(refreshInfo.platform, refreshInfo.room)
    if (!r.ok || !r.url) return null
    return { url: r.url, expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : 0 }
  }

  status() {
    const s = super.status()
    const cfg = this.ctx.config || {}
    return {
      ...s,
      pathName: cfg.pathName || 'live',
      defaultTranscode: !!cfg.transcode,
      defaultRecord: !!(cfg.record && cfg.record.enabled),
      mediamtx: cfg.mediamtxOk ? cfg.mediamtxOk() : false,
    }
  }
}

StationService.inject = [...StationBase.inject, 'resolver']

export default function stationPlugin(ctx) {
  ctx.plugin(StationService)
}