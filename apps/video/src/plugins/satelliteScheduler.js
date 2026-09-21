// satelliteScheduler —— 转播站进程内的每日卫星影像调度服务。
//
// 设计要点：
//   - 读取 ctx.config.satellite（config 插件已解析）；satellite.enabled 与 satellite.auto
//     任一为 false 时不启用（配置热更新也会即时生效，因 satellite 在 HOT_KEYS 白名单）；
//   - 按墙钟在每日 satellite.hour:00 触发一次；若进程在当日触发点之后才启动
//     （如转播站白天才开），会在启动后 ~5 分钟做一次「补跑」，随后回到每日节律；
//   - 调用 scripts/satellite-daily.mjs（与 WorkBuddy 自动化共用同一条编排逻辑），避免重复；
//   - satellite-daily.mjs 内部已有进程锁，故即使本服务与 WorkBuddy 自动化同时触发，也只跑一次；
//   - 生成完成 emit 'satellite:generated'，供 web 层在面板轮询之外即时刷新状态（可选消费）。
import { Service } from 'cordis'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..', '..') // src/plugins -> src -> apps/video
const ROOT = path.resolve(APP_DIR, '..', '..')
const DAILY_SCRIPT = path.resolve(ROOT, 'scripts', 'satellite-daily.mjs')

class SatelliteScheduler extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'satelliteScheduler')
    const sc = ctx.config.satellite || {}
    this.enabled = sc.enabled !== false && sc.auto !== false
    this.hour = Number(sc.hour)
    if (!Number.isInteger(this.hour) || this.hour < 0 || this.hour > 23) this.hour = 3
    this.timer = null
    this.catchupTimer = null

    if (!this.enabled) {
      ctx.logger.info('[satellite-scheduler] 未启用（satellite.enabled/auto=false），跳过')
      return
    }
    // 直接在构造期排程（无需等待 ready）：真正触发在数小时之后，
    // 此时其余插件必然已就绪；且定时器不依赖任何运行时状态。
    this.schedule()
  }

  schedule() {
    const now = new Date()
    const todayRun = new Date(now)
    todayRun.setHours(this.hour, 0, 0, 0)
    if (now > todayRun) {
      // 今日触发点已过：5 分钟后补跑一次，覆盖「转播站白天才开」的情形
      this.ctx.logger.info(`[satellite-scheduler] 今日 ${this.hour}:00 已过的，5 分钟后补跑一次`)
      this.catchupTimer = setTimeout(() => {
        this.runOnce()
        this.scheduleNext()
      }, 5 * 60 * 1000)
    } else {
      this.scheduleNext()
    }
  }

  scheduleNext() {
    const now = new Date()
    const next = new Date(now)
    next.setHours(this.hour, 0, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    const ms = next - now
    this.ctx.logger.info(
      `[satellite-scheduler] 下次生成：${next.toISOString()}（约 ${Math.round(ms / 60000)} 分钟后）`
    )
    this.timer = setTimeout(() => {
      this.runOnce()
      this.scheduleNext()
    }, ms)
  }

  runOnce() {
    this.ctx.logger.info('[satellite-scheduler] 触发每日卫星影像生成…')
    const child = spawn(process.execPath, [DAILY_SCRIPT], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()
    child.on('exit', (code) => {
      if (code === 0) {
        this.ctx.logger.info('[satellite-scheduler] 生成完成')
        this.ctx.emit('satellite:generated', { at: Date.now() })
      } else {
        this.ctx.logger.warn(
          `[satellite-scheduler] 生成退出码 ${code}（详见 apps/video/satellite/.daily-*.log）`
        )
      }
    })
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    if (this.catchupTimer) clearTimeout(this.catchupTimer)
    this.timer = null
    this.catchupTimer = null
  }
}

export default function satelliteScheduler(ctx, cfg) {
  ctx.plugin(SatelliteScheduler, cfg)
}
