// musickit 音源插件单测（node:test）：用假渲染器验证 渲染→队列→状态→停止 全链路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import musickitPlugin from '../src/plugins/musickit.js'

class FakeConfig extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'config')
    Object.assign(this, cfg)
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function makeCtx(dir, overrides = {}) {
  // 假渲染器：按契约输出 JSON 并创建一个文件
  const renderer = path.join(dir, 'remix', 'tools', 'musickit_render_one.py')
  fs.mkdirSync(path.dirname(renderer), { recursive: true })
  fs.writeFileSync(renderer, [
    'import json, os, sys',
    'out = sys.argv[sys.argv.index("--out") + 1]',
    'os.makedirs(out, exist_ok=True)',
    'p = os.path.join(out, "fake_track.mp3")',
    'open(p, "wb").write(b"ID3")',
    'print(json.dumps({"ok": True, "file": p, "style": "test", "label": "L", "subgenre": "S", "bpm": "120"}))',
  ].join('\n'))
  const ctx = new Context()
  ctx.plugin(FakeConfig, {
    port: 0,
    musickit: {
      root: dir,
      python: process.env.PLATFORM_PYTHON || 'python',
      channel: 'random', bars: 32, format: 'mp3', maxTracks: 5,
      fusion: false, releaseSafe: false, timeoutSec: 60,
      cacheDir: path.join(dir, 'radio', 'render_cache'),
      keep: 20, queueDepth: 3, maxFails: 3,
      ...overrides,
    },
  })
  ctx.plugin(musickitPlugin)
  return ctx
}

async function waitFor(fn, timeout = 10000, step = 100) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fn()) return true
    await tick(step)
  }
  return false
}

test('start 后渲染入队，状态字段齐全，stop 清空', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-musickit-'))
  const ctx = makeCtx(dir)
  await tick()
  const m = ctx.musickit
  m.start('phonk', 32)
  const ok = await waitFor(() => m.queue.length > 0 && m.renderedCount > 0)
  assert.equal(ok, true)
  const s = m.status()
  assert.deepEqual(Object.keys(s).sort(), ['active', 'bars', 'cache_dir', 'channel', 'current', 'last_error', 'queued', 'rendered_count', 'rendering'].sort())
  assert.equal(s.channel, 'phonk')
  assert.equal(s.active, true)
  assert.equal(s.last_error, '')
  m.stop()
  assert.equal(m.queue.length, 0)
  assert.equal(m.status().active, false)
  const s2 = m.status()
  assert.equal(s2.queued, 0)
  await tick()
})

test('渲染器失败 → last_error 记录 → 连续失败自动停（maxFails）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-musickit-fail-'))
  const ctx = makeCtx(dir)
  await tick()
  // 覆盖假渲染器为必败版
  const renderer = path.join(dir, 'remix', 'tools', 'musickit_render_one.py')
  fs.writeFileSync(renderer, 'import sys\nsys.exit(3)\n')
  const m = ctx.musickit
  m.start()
  const ok = await waitFor(() => m.status().active === false, 15000)
  assert.equal(ok, true, '连续失败应自动停止')
  assert.ok(m.lastError.includes('放弃重试') || m.lastError.includes('退出码'), '应有错误记录: ' + m.lastError)
  assert.equal(m.renderedCount, 0)
})

test('advance 从队列取曲并更新 current', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-musickit-adv-'))
  const ctx = makeCtx(dir)
  await tick()
  const m = ctx.musickit
  m.start()
  await waitFor(() => m.queue.length > 0)
  const meta = m.advance()
  assert.ok(meta && meta.file)
  assert.equal(m.currentPath(), meta.file)
  assert.ok(m.currentTitle().includes('随机渲染'))
  m.stop()
})
