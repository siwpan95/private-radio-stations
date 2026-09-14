/**
 * localplayer-bridge 的集成测试：起一组「假上游」，真起桥进程，断言聚合结果。
 *
 * 为什么要造假的：桥的每个源都依赖 audio/video/MediaMTX 三个上游在线，
 * 而它们各自的启动条件（ffmpeg、MediaMTX、真实频道源）不是单测该背的。
 * 用假上游可以**确定性地**覆盖解析与降级逻辑，且任何人 `npm test` 都能复现。
 *
 * 运行：node --test scripts/localplayer-bridge.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, 'localplayer-bridge.mjs')
const NODE = process.execPath

const killers = []
after(() => { while (killers.length) { try { killers.pop()() } catch (_) { /* ignore */ } } })

/** 起一个假 HTTP 上游；routes: { 'GET /path': (req,res)=>... } */
function fakeUpstream(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const key = `${req.method} ${decodeURIComponent(req.url.split('?')[0])}`
      const h = routes[key]
      if (!h) { res.writeHead(404); res.end('nope'); return }
      h(req, res)
    })
    srv.listen(0, '127.0.0.1', () => {
      killers.push(() => srv.close())
      resolve(`http://127.0.0.1:${srv.address().port}`)
    })
  })
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/** 起桥进程；返回 { base, stop }。会轮询 /api/health 直到就绪。 */
async function startBridge(env) {
  const srv = http.createServer(() => {})
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r)) // 先探一个空闲端口再交给子进程（有极小竞态，但够用）

  const child = spawn(NODE, [BRIDGE], {
    env: { ...process.env, LP_BRIDGE_PORT: String(port), LP_TIMEOUT_MS: '1200', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  killers.push(() => { try { child.kill() } catch (_) { /* ignore */ } })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 8000
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return { base, stop: () => child.kill() }
    } catch (e) { lastErr = e }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`桥未能在 8s 内就绪: ${lastErr && lastErr.message}`)
}

test('上游全在线：按声明顺序聚合成清单，且过滤掉 Chromium 解不了的 .ts', async () => {
  const audio = await fakeUpstream({
    'GET /api/status': (_, res) => json(res, 200, {
      mode: 'relay',
      current: { name: '测试电台' },
      hls_url: '/hls/live.m3u8',
    }),
    'GET /api/presets': (_, res) => json(res, 200, {
      presets: [{ name: '预设A', url: 'http://example.invalid/a.mp3' }],
    }),
  })
  const video = await fakeUpstream({
    'GET /api/channels': (_, res) => json(res, 200, {
      playlists: ['p'],
      channels: [
        { name: 'CCTV1', group: '央视', urls: ['http://example.invalid/1.m3u8'] },
      ],
    }),
    'GET /api/recordings': (_, res) => json(res, 200, {
      recordings: [
        { name: 'rec.ts', size: 1 },   // Chromium 无原生 MPEG-TS 解码器 → 应被过滤
        { name: 'rec.mp4', size: 2 },
      ],
    }),
  })
  const mtx = await fakeUpstream({
    'GET /live/index.m3u8': (_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end('#EXTM3U\n')
    },
  })

  const { base } = await startBridge({
    LP_AUDIO_BASE: audio, LP_VIDEO_BASE: video, LP_MTX_BASE: mtx,
  })

  const items = await (await fetch(`${base}/api/list`)).json()
  assert.deepEqual(items.map((i) => i.name), [
    '电台直播 · 测试电台',
    '电台直播 · HLS',
    '预设A',
    '本地直播（HLS）',
    '央视 · CCTV1',
    '录制 · rec.mp4',
  ])
  assert.deepEqual(items.map((i) => i.type), ['audio', 'audio', 'audio', 'video', 'video', 'video'])
  // .ts 录制不应出现
  assert.ok(!items.some((i) => /\.ts($|\?)/.test(i.path)), '不应列出 .ts 录制')
  // 录制文件的 URL 指向 video 应用自己的静态路由
  assert.equal(items[5].path, `${video}/recordings/rec.mp4`)
  // HLS 相对路径应被补全成绝对地址
  assert.equal(items[1].path, `${audio}/hls/live.m3u8`)
})

test('未转播时：/stream 与 HLS 不列入（避免给一条静音占位流）', async () => {
  const audio = await fakeUpstream({
    'GET /api/status': (_, res) => json(res, 200, { mode: 'idle', current: null }),
    'GET /api/presets': (_, res) => json(res, 200, { presets: [] }),
  })
  const video = await fakeUpstream({
    'GET /api/channels': (_, res) => json(res, 200, { channels: [] }),
    'GET /api/recordings': (_, res) => json(res, 200, { recordings: [] }),
  })
  const mtx = await fakeUpstream({}) // 什么都没有 → 404

  const { base } = await startBridge({
    LP_AUDIO_BASE: audio, LP_VIDEO_BASE: video, LP_MTX_BASE: mtx,
  })

  const items = await (await fetch(`${base}/api/list`)).json()
  assert.deepEqual(items, [], '没有可播内容时应返回空数组，让扩展回落到本地打包媒体')

  const health = await (await fetch(`${base}/api/health`)).json()
  assert.equal(health.hasMedia, false)
  // 未转播 = 「当前没有」，不是故障；MediaMTX 连不上但在 404 时也不算故障
  const byId = Object.fromEntries(health.sources.map((s) => [s.id, s]))
  assert.equal(byId['audio.live'].state, 'empty')
  assert.equal(byId['video.hls'].state, 'empty')
})

test('上游全挂：桥仍然可用，清单为空且体检给出原因', async () => {
  // 用没人监听的端口模拟「服务没起」
  const { base } = await startBridge({
    LP_AUDIO_BASE: 'http://127.0.0.1:1',
    LP_VIDEO_BASE: 'http://127.0.0.1:1',
    LP_MTX_BASE: 'http://127.0.0.1:1',
  })

  const health = await (await fetch(`${base}/api/health`)).json()
  assert.equal(health.alive, true, '桥本身必须活着——否则扩展会以为整个联动都坏了')
  assert.equal(health.hasMedia, false)
  assert.ok(health.sources.every((s) => s.state === 'error'))
  assert.ok(health.sources.every((s) => s.error), '每个失败源都要给出原因')

  const items = await (await fetch(`${base}/api/list`)).json()
  assert.deepEqual(items, [])
})

test('同一 URL 被多个源给出时只出现一次', async () => {
  const dup = 'http://example.invalid/same.mp3'
  const audio = await fakeUpstream({
    'GET /api/status': (_, res) => json(res, 200, { mode: 'idle' }),
    'GET /api/presets': (_, res) => json(res, 200, {
      presets: [{ name: '甲', url: dup }, { name: '乙', url: dup }],
    }),
  })
  const video = await fakeUpstream({
    'GET /api/channels': (_, res) => json(res, 200, { channels: [] }),
    'GET /api/recordings': (_, res) => json(res, 200, { recordings: [] }),
  })
  const { base } = await startBridge({ LP_AUDIO_BASE: audio, LP_VIDEO_BASE: video, LP_MTX_BASE: video })

  const items = await (await fetch(`${base}/api/list`)).json()
  assert.equal(items.length, 1)
  assert.equal(items[0].path, dup)
})
