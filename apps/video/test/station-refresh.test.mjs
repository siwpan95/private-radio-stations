// station 自动续播单测（node:test，零依赖）：平台源 refreshInfo/expiresAt 的
// 被动续播（noteEnded/noteFailure）、主动续播（到期定时器）、下播停止、
// 防重入、无平台源行为不变。M3 之后这些测试同时覆盖 @relay/core 的基类。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from 'cordis'
import stationPlugin from '../src/plugins/station.js'
import invariantsPlugin from '@relay/core/src/invariants.js'

class FakeConfig extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'config')
    Object.assign(this, cfg)
  }
}

class FakeResolver extends Service {
  constructor(ctx, impl) {
    super(ctx, 'resolver')
    this.impl = impl || (async () => null)
    this.calls = []
  }

  async resolve(platform, room) {
    this.calls.push([platform, room])
    return this.impl(platform, room)
  }
}

function makeCtx(resolveImpl, cfg = {}) {
  const ctx = new Context()
  ctx.plugin(FakeConfig, {
    version: '1.0.0',
    pathName: 'live',
    transcode: false,
    record: { enabled: false },
    ffmpegOk: () => true,
    mediamtxOk: () => true,
    ...cfg,
  })
  ctx.plugin(invariantsPlugin, {})
  ctx.plugin(FakeResolver, resolveImpl)
  ctx.plugin(stationPlugin)
  return ctx
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const PLAT = { platform: 'douyu', room: '9999' }

test('被动续播：平台源长跑退出 → 重解析成功 → 换新 URL 并重启（relay:retry）', async () => {
  let url = 'https://x/live/a.m3u8?txTime=old'
  const ctx = makeCtx(async (p, r) => {
    assert.equal(p, 'douyu'); assert.equal(r, '9999')
    url = 'https://x/live/b.m3u8?txTime=new'
    return { ok: true, url, expiresAt: 0 }
  })
  await tick()
  ctx.station.setRelay('https://x/live/a.m3u8?txTime=old', '斗鱼 9999', [], { refreshInfo: PLAT })
  let retried = null
  ctx.on('relay:retry', (cur) => { retried = cur })
  ctx.station.noteEnded()
  await tick()
  await tick()
  assert.equal(ctx.station.current.url, 'https://x/live/b.m3u8?txTime=new')
  assert.equal(ctx.station.refreshCount, 1)
  assert.equal(ctx.station.failureCount, 0)
  assert.equal(ctx.station.error, null)
  assert.equal(retried.url, 'https://x/live/b.m3u8?txTime=new')
  assert.equal(ctx.resolver.calls.length, 1)
  assert.equal(ctx.station.status().refreshing, false)
})

test('下播停止：重解析返回 null → 明确错误提示，不崩溃', async () => {
  const ctx = makeCtx(async () => ({ ok: false, error: '房间未开播' }))
  await tick()
  ctx.station.setRelay('https://x/live/a.m3u8', '斗鱼 9999', [], { refreshInfo: PLAT })
  ctx.station.noteEnded()
  await tick()
  await tick()
  assert.equal(ctx.station.mode, 'relay')
  assert.ok(ctx.station.error.includes('未开播'))
  assert.equal(ctx.station.refreshCount, 1)
  assert.equal(ctx.station.current.url, 'https://x/live/a.m3u8')
})

test('失败路径续播：单源连续失败且带平台信息 → 走重解析而非「停止自动重试」', async () => {
  const ctx = makeCtx(async () => ({ ok: true, url: 'https://x/live/fresh.m3u8', expiresAt: 0 }))
  await tick()
  ctx.station.setRelay('https://x/live/dead.m3u8', '斗鱼 9999', [], { refreshInfo: PLAT })
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  await tick()
  await tick()
  assert.equal(ctx.station.current.url, 'https://x/live/fresh.m3u8')
  assert.equal(ctx.station.refreshCount, 1)
  assert.equal(ctx.station.error, null)
})

test('主动续播：expiresAt 到期前触发重解析（mock timers 快进）', async (t) => {
  const flush = async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  }
  const now = Date.now()
  let url = 'https://x/live/old.m3u8'
  const ctx = makeCtx(async () => {
    url = 'https://x/live/new.m3u8'
    return { ok: true, url, expiresAt: Math.floor(now / 1000) + 7200 }
  })
  await tick() // 先让 cordis 完成插件挂载（真实定时器），再启用 mock
  t.mock.timers.enable({ apis: ['setTimeout'] })
  ctx.station.setRelay('https://x/live/old.m3u8', '斗鱼 9999', [], {
    refreshInfo: PLAT,
    expiresAt: Math.floor(now / 1000) + 35, // 到期前 30s 提前量 → 5s 下限
  })
  assert.equal(ctx.resolver.calls.length, 0)
  t.mock.timers.tick(5100)
  await flush()
  assert.equal(ctx.resolver.calls.length, 1)
  assert.equal(ctx.station.current.url, 'https://x/live/new.m3u8')
  assert.equal(ctx.station.refreshCount, 1)
})

test('防重入：重解析挂起期间再次退出不重复调用', async () => {
  let resolveResolve
  const gate = new Promise((r) => { resolveResolve = r })
  const ctx = makeCtx(async () => {
    await gate
    return { ok: true, url: 'https://x/live/late.m3u8', expiresAt: 0 }
  })
  await tick()
  ctx.station.setRelay('https://x/live/a.m3u8', '斗鱼 9999', [], { refreshInfo: PLAT })
  ctx.station.noteEnded()
  await tick()
  ctx.station.noteEnded() // 重解析进行中，应被防重入拦下
  await tick()
  assert.equal(ctx.resolver.calls.length, 1)
  resolveResolve()
  await tick()
  await tick()
  assert.equal(ctx.station.current.url, 'https://x/live/late.m3u8')
  assert.equal(ctx.station.refreshCount, 1)
})

test('停止转播清理：到期定时器随 stopRelay 取消', async (t) => {
  const flush = async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  }
  const now = Date.now()
  const ctx = makeCtx(async () => ({ ok: true, url: 'https://x/live/n.m3u8', expiresAt: 0 }))
  await tick()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  ctx.station.setRelay('https://x/live/a.m3u8', '斗鱼 9999', [], {
    refreshInfo: PLAT,
    expiresAt: Math.floor(now / 1000) + 35,
  })
  ctx.station.stopRelay()
  t.mock.timers.tick(5100)
  await flush()
  assert.equal(ctx.resolver.calls.length, 0)
  assert.equal(ctx.station.mode, 'idle')
})

test('无平台源行为不变：noteEnded 提示播完、连续失败提示停止重试，不调解析器', async () => {
  const ctx = makeCtx(async () => ({ ok: true, url: 'https://x/should-not.m3u8' }))
  await tick()
  ctx.station.setRelay('http://a/stream', '台A')
  ctx.station.noteEnded()
  assert.ok(ctx.station.error.includes('播放结束'))
  ctx.station.setRelay('http://b/stream', '台B')
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  assert.ok(ctx.station.error.includes('停止自动重试'))
  assert.equal(ctx.resolver.calls.length, 0)
  assert.equal(ctx.station.refreshCount, 0)
})

test('expiresAt 缺省（0）：只被动续播，不排定时器', async () => {
  const ctx = makeCtx(async () => ({ ok: true, url: 'https://x/live/n.m3u8', expiresAt: 0 }))
  await tick()
  ctx.station.setRelay('https://x/live/a.m3u8', '斗鱼 9999', [], { refreshInfo: PLAT })
  assert.equal(ctx.station.refreshTimer, null)
  assert.equal(ctx.station.status().expiresAt, 0)
  ctx.station.noteEnded()
  await tick()
  await tick()
  assert.equal(ctx.resolver.calls.length, 1)
})

test('换源切换（failover）不触发平台源重解析', async () => {
  const ctx = makeCtx(async () => ({ ok: true, url: 'https://x/n.m3u8' }))
  await tick()
  ctx.station.setRelay('https://x/live/a.m3u8', '主', ['https://x/live/b.m3u8'], { refreshInfo: PLAT })
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  assert.equal(ctx.station.current.url, 'https://x/live/b.m3u8')
  assert.equal(ctx.resolver.calls.length, 0)
  assert.equal(ctx.station.status().refreshInfo, null) // 备用源无平台信息
})
