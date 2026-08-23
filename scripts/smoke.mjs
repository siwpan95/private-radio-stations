// smoke.mjs — 端到端冒烟：对已运行的实例（node src/index.js）做全链路自检。
// 用法：先起服务，再  node scripts/smoke.mjs
// 断言：状态接口 → 开始转播（mux 测试源）→ MediaMTX 就绪 → HLS 可达 →
//       RTSP 可拉流 → 录像落盘 → 停止转播。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:8100'
const FFMPEG = process.env.FFMPEG || path.resolve(__dirname, '..', 'ffmpeg', 'ffmpeg.exe')
const TEST_URL = process.env.SMOKE_SOURCE || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  PASS  ' + name)
  else { failures += 1; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

async function api(path, opts = {}) {
  const resp = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  return resp.json().catch(() => ({}))
}

function ffmpegPull(rtsp, sec = 6) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-t', String(sec), '-rtsp_transport', 'tcp', '-i', rtsp, '-c', 'copy', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('== smoke: ' + BASE + ' ==')
const s0 = await api('/api/status')
check('status api', !!s0.version, JSON.stringify(s0).slice(0, 120))
check('ffmpeg found', s0.ffmpeg === true)

const presets = await api('/api/presets')
check('presets list', Array.isArray(presets.presets) && presets.presets.length > 0)

console.log('-- 开始转播（' + TEST_URL + '）--')
await api('/api/relay', { method: 'POST', body: JSON.stringify({ url: TEST_URL, name: 'smoke-test', record: true }) })

let ok = false
for (let i = 0; i < 40; i++) {
  await sleep(3000)
  const s = await api('/api/status')
  if (s.mode === 'relay' && s.streamer.running && s.mediamtx.api && s.mediamtx.api.ready) { ok = true; break }
  if (s.error) console.log('  info   retry ' + i + ': ' + s.error)
}
check('relay running + mediamtx path ready', ok)

if (ok) {
  const s = await api('/api/status')
  const hls = await fetch(s.urls.hls.replace(s.urls.host, '127.0.0.1'))
  const manifest = await hls.text()
  check('HLS manifest', hls.ok && manifest.includes('#EXTM3U'), manifest.slice(0, 80))

  const rtsp = s.urls.rtsp.replace(s.urls.host, '127.0.0.1')
  const pulled = await ffmpegPull(rtsp, 6)
  check('RTSP pull 6s', pulled)

  await sleep(6000)
  const s2 = await api('/api/status')
  check('recording running', s2.recorder.running === true)
  check('recording has bytes', s2.recorder.bytes > 100000, 'bytes=' + s2.recorder.bytes)
  await api('/api/record', { method: 'POST', body: JSON.stringify({ on: false }) })
  const s3 = await api('/api/status')
  check('recording stopped', s3.recorder.running === false)
  check('recording file exists', fs.existsSync(s3.recorder.file || ''))
}

await api('/api/relay/stop', { method: 'POST' })
const sEnd = await api('/api/status')
check('relay stopped', sEnd.mode === 'idle')

console.log(failures === 0 ? '== SMOKE PASS ==' : '== SMOKE FAIL (' + failures + ') ==')
process.exit(failures === 0 ? 0 : 1)
