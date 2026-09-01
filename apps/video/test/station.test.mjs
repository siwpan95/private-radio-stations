// station 状态机单测（node:test，零依赖）——验证视频语义：transcode/record 标志、
// noteEnded、failover、waterfall 拦截。M3 之后这些测试同时覆盖 @relay/core 的基类。
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
  constructor(ctx) {
    super(ctx, 'resolver')
  }

  async resolve() {
    return { ok: false, error: 'not wired in this test' }
  }
}

function makeCtx(cfg = {}) {
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
  ctx.plugin(FakeResolver)
  ctx.plugin(stationPlugin)
  return ctx
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('初始为空闲', async () => {
  const ctx = makeCtx()
  await tick()
  assert.equal(ctx.station.mode, 'idle')
  assert.equal(ctx.station.activeUrl(), null)
})

test('setRelay 进入转播并发出事件（带 transcode/record 标志）', async () => {
  const ctx = makeCtx()
  await tick()
  let started = null
  ctx.on('relay:start', (cur) => { started = cur })
  ctx.station.setRelay('http://a/stream', '台A', [], { transcode: true, record: true })
  assert.equal(ctx.station.mode, 'relay')
  assert.equal(ctx.station.activeUrl(), 'http://a/stream')
  assert.equal(started.transcode, true)
  assert.equal(started.record, true)
})

test('setRelay 多源 failover：主源优先，备用入队', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.station.setRelay('http://a/stream', '台A', ['http://b/stream'])
  assert.equal(ctx.station.sources.length, 2)
  assert.equal(ctx.station.current.url, 'http://a/stream')
  assert.equal(ctx.station.status().sourceCount, 2)
})

test('noteFailure 达到阈值后切到备用源', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.station.setRelay('http://a/stream', '台A', ['http://b/stream'])
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  assert.equal(ctx.station.current.url, 'http://a/stream')
  ctx.station.noteFailure()
  assert.equal(ctx.station.current.url, 'http://b/stream')
  assert.equal(ctx.station.failureCount, 0)
})

test('单源连续失败：停重试并给错误提示，不崩溃', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.station.setRelay('http://a/stream', '台A')
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  assert.equal(ctx.station.mode, 'relay')
  assert.ok(ctx.station.error.includes('停止自动重试'))
})

test('noteEnded 记错误但不切源', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.station.setRelay('http://a/stream', '台A', ['http://b/stream'])
  ctx.station.noteEnded()
  assert.equal(ctx.station.current.url, 'http://a/stream')
  assert.ok(ctx.station.error.includes('播放结束'))
})

test('stopRelay 回到空闲并清空源', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.station.setRelay('http://a/stream', '台A')
  let stopped = false
  ctx.on('relay:stop', () => { stopped = true })
  ctx.station.stopRelay()
  assert.equal(ctx.station.mode, 'idle')
  assert.equal(ctx.station.current, null)
  assert.equal(ctx.station.sources.length, 0)
  assert.equal(stopped, true)
})

test('relay:pre-start 监听器返回 false 可否决开播', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.on('relay:pre-start', () => false)
  ctx.station.setRelay('http://a/stream', '台A')
  assert.equal(ctx.station.mode, 'idle')
  assert.equal(ctx.station.current, null)
  assert.ok(ctx.station.error.includes('拦截'))
})


// ---- 运行时不变量（HARNESS P5）----

test('合法迁移序列不触发不变量失败', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.station.setRelay('http://a/stream', '台A', ['http://b/stream'])
  ctx.station.noteFailure()
  ctx.station.noteFailure()
  ctx.station.noteFailure() // 切源
  ctx.station.stopRelay()
  assert.deepEqual(ctx.invariants.failures, [])
  assert.equal(ctx.invariants.status().checks, 6)
})

test('状态被破坏时（relay 但 current 为空）不变量会报出', async () => {
  const ctx = makeCtx()
  await tick()
  ctx.station.setRelay('http://a/stream', '台A')
  // 人为破坏：直接改状态（绕过迁移方法）
  ctx.station.current = null
  ctx.invariants.run('test') // 对破坏态直接执行断言
  assert.ok(ctx.invariants.failures.length >= 1)
  assert.ok(ctx.invariants.failures[0].includes('relay 状态一致'))
})

test('status 包含版本与健康字段', async () => {
  const ctx = makeCtx()
  await tick()
  const s = ctx.station.status()
  assert.equal(s.version, '1.0.0')
  assert.equal(s.mode, 'idle')
  assert.equal(s.pathName, 'live')
  assert.equal(s.ffmpeg, true)
  assert.equal(s.mediamtx, true)
})