// station 插件：核心状态机在 @relay/core/station-base，这里只扩展 status() 健康字段。
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
      pathName: cfg.pathName || 'live',
      defaultTranscode: !!cfg.transcode,
      defaultRecord: !!(cfg.record && cfg.record.enabled),
      mediamtx: cfg.mediamtxOk ? cfg.mediamtxOk() : false,
    }
  }
}

StationService.inject = [...StationBase.inject]

export default function stationPlugin(ctx) {
  ctx.plugin(StationService)
}