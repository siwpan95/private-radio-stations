// station × musickit 音源接线单测（S4b）：播放/轮换/队列等待/停止。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from 'cordis'
import musickitPlugin from '../src/plugins/musickit.js'
import stationPlugin from '../src/plugins/station.js'

class FakeConfig extends Service {
  constructor(ctx, cfg) { super(ctx, 'config'); Object.assign(this, cfg) }
}
class FakeLogfile extends Service {
  constructor(ctx) { super(ctx, 'logfile'); this.recentErrors = () => []; this.status = () => ({}) }
}
class FakeInvariants extends Service {
  constructor(ctx) {
    super(ctx, 'invariants')
    this._rules = new Map()
  }
  register(name, fn) { this._rules.set(name, fn) }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function makeCtx() {
  const ctx = new Context()
  ctx.plugin(FakeConfig, { port: 0, transcodeMounts: [], hls: { enabled: false }, musickit: { cacheDir: 'x', keep: 20, queueDepth: 3 } })
  ctx.plugin(FakeLogfile)
  ctx.plugin(FakeInvariants)
  ctx.plugin(musickitPlugin)
  ctx.plugin(stationPlugin)
  return ctx
}

function injectTracks(ctx, tracks) {
  ctx.musickit.queue = tracks.map((t, i) => ({ file: t, title: '曲目' + i }))
  ctx.musickit.advance = function () { return this.queue.shift() || null }
  ctx.musickit.start = function () {}
  ctx.musickit.stop = function () {}
}

test('playMusickit 进入 relay 模式并取首曲', async () => {
  const ctx = makeCtx()
  await tick()
  injectTracks(ctx, ['G:/x/a.mp3', 'G:/x/b.mp3'])
  const s = ctx.station
  assert.equal(s.playMusickit(), true)
  assert.equal(s.mode, 'relay')
  assert.equal(s._musickit, true)
  assert.equal(s.current.url, 'G:/x/a.mp3')
  assert.equal(s.current.name, '曲目0')
  assert.equal(s.status().musickit, true)
})

test('advanceMusickitTrack 轮换到下一曲', async () => {
  const ctx = makeCtx()
  await tick()
  injectTracks(ctx, ['G:/x/a.mp3', 'G:/x/b.mp3'])
  const s = ctx.station
  s.playMusickit()
  s.advanceMusickitTrack()
  assert.equal(s.current.url, 'G:/x/b.mp3')
})

test('队列空时等待；有新曲后可接管', async () => {
  const ctx = makeCtx()
  await tick()
  injectTracks(ctx, [])
  const s = ctx.station
  s.playMusickit()
  assert.equal(s._musickit, true)
  assert.equal(s.current, null)
  ctx.musickit.queue.push({ file: 'G:/x/c.mp3', title: '曲目C' })
  s.advanceMusickitTrack()
  assert.equal(s.current.url, 'G:/x/c.mp3')
  assert.equal(s.mode, 'relay')
})

test('stopMusickit 复位并停转播', async () => {
  const ctx = makeCtx()
  await tick()
  injectTracks(ctx, ['G:/x/a.mp3'])
  const s = ctx.station
  s.playMusickit()
  s.stopMusickit()
  assert.equal(s._musickit, false)
  assert.equal(s.mode, 'idle')
  assert.equal(s.current, null)
})
