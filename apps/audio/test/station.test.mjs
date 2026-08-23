// station 状态机单测（node:test，零依赖）
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

function makeCtx(cfg = {}) {
  const ctx = new Context()
  ctx.plugin(FakeConfig, {
    version: '3.0.0',
    transcodeMounts: [64, 320],
    hls: { enabled: true, variants: [128, 64] },
    ffmpegOk: () => true,
    ...cfg,
  })
  ctx.plugin(invariantsPlugin, {})
  ctx.plugin(stationPlugin)
  return ctx
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('初始为空闲', async () => {
  const ctx = makeCtx()
  await tick()
  const st = ctx.station
  assert.equal(st.mode, 'idle')
  assert.equal(st.activeUrl(), null)
})

test('setRelay 进入转播并发出事件', async () => {
  const ctx = makeCtx()
  await tick()
  let started = null
  ctx.on('relay:start', (cur) => { started = cur })
  ctx.station.setRelay('http://a/stream', '台A')
  assert.equal(ctx.station.mode, 'relay')
  assert.equal(ctx.station.activeUrl(), 'http://a/stream')
  assert.deepEqual(started, { url: 'http://a/stream', name: '台A', transcode: false, record: false })
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
  assert.equal(ctx.station.current.url, 'http://a/stream') // 还没到阈值
  ctx.station.noteFailure()
  assert.equal(ctx.station.current.url, 'http://b/stream') // 第 3 次切源
  assert.equal(ctx.station.failureCount, 0)
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

test('status 包含版本与健康字段', async () => {
  const ctx = makeCtx()
  await tick()
  const s = ctx.station.status()
  assert.equal(s.version, '3.0.0')
  assert.equal(s.mode, 'idle')
  assert.deepEqual(s.mounts, [64, 320])
  assert.deepEqual(s.hls_variants, [128, 64])
  assert.equal(s.ffmpeg, true)
})