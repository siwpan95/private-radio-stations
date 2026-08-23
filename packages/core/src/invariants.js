// @relay/core — 运行时不变量服务（借鉴 deepseek-harness invariants）。
// 只断言可观察关系：事件配对 / 数据守恒。register 注册断言，run 全量执行。
import { Service } from 'cordis'

export class InvariantsService extends Service {
  constructor(ctx, cfg = {}) {
    super(ctx, 'invariants')
    this.enabled = cfg.enabled !== false
    this.checks = new Map()
    this.failures = []
  }

  register(name, check) {
    this.checks.set(name, check)
  }

  run(tag = '') {
    if (!this.enabled) return true
    let ok = true
    for (const [name, check] of this.checks) {
      try {
        const r = check()
        if (r === false) throw new Error('assertion returned false')
      } catch (e) {
        ok = false
        const msg = '[INVARIANT] ' + name + (tag ? ' @' + tag : '') + ': ' + (e && e.message ? e.message : e)
        this.failures.push(msg)
        if (this.failures.length > 20) this.failures.shift()
        this.ctx.logger.error(msg)
      }
    }
    return ok
  }

  status() {
    return { enabled: this.enabled, checks: this.checks.size, failures: this.failures.slice(-5) }
  }
}

InvariantsService.inject = ['config']

export default function invariantsPlugin(ctx, cfg) {
  ctx.plugin(InvariantsService, cfg)
}
