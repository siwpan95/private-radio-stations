// 端到端冒烟：拉起服务 → 轮询端点 → 断言关键行为 → 收尾。
// 用法：node scripts/smoke.mjs   （需 ffmpeg 才全量；无 ffmpeg 自动降级断言）
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const NODE = process.env.NODE_EXE || 'node'
const PORT = Number(process.env.PORT) || 8123
let BASE = 'http://127.0.0.1:' + PORT

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
    srv.on('error', reject)
  })
}

async function get(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, opts)
  return r
}

async function main() {
  const port = PORT === 8123 ? await freePort() : PORT
  BASE = 'http://127.0.0.1:' + port
  const base = BASE
  const child = spawn(NODE, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (c) => { logs += c })
  child.stderr.on('data', (c) => { logs += c })
  const results = []
  const ok = (name, cond, extra = '') => {
    results.push([name, !!cond])
    console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : ''))
  }
  try {
    // 等服务起来
    let status = null
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(base + '/api/status')
        if (r.ok) { status = await r.json(); break }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    ok('服务启动', !!status)
    if (!status) throw new Error('server did not start' + String.fromCharCode(10) + logs)

    ok('status.version', status.version === '3.0.0', String(status.version))
    ok('status 健康字段', 'uptime' in status && 'ffmpeg_children' in status && 'hls' in status && 'recent_errors' in status)

    const root = await fetch(base + '/')
    ok('面板 200', root.status === 200 && (await root.text()).length > 1000)

    const presets = await (await fetch(base + '/api/presets')).json()
    ok('presets 列表', Array.isArray(presets.presets))

    // 空闲态 /stream = 台标音循环（200 + 音频字节）
    const ctrl = new AbortController()
    const idle = await fetch(base + '/stream', { signal: ctrl.signal })
    ok('空闲 /stream 200', idle.status === 200)
    if (idle.ok && idle.body) {
      const reader = idle.body.getReader()
      let bytes = 0
      try {
        for (let i = 0; i < 20; i++) {
          const t = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 500))])
          if (t.done) break
          bytes += t.value.length
          if (bytes > 8192) break
        }
      } catch { /* 超时=还在出流，视为正常 */ }
      ok('空闲 /stream 有音频字节', bytes > 0, bytes + ' bytes')
      ctrl.abort()
    }

    // 转播（本地数据源文件？—— 无外部网络时跳过真源，只验证 API 状态机）
    const relay = await fetch(base + '/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/nonexistent' }),
    })
    ok('POST /api/relay 200', relay.status === 200)
    const s2 = await (await fetch(base + '/api/status')).json()
    ok('进入 relay 模式', s2.mode === 'relay')
    const stop = await fetch(base + '/api/relay/stop', { method: 'POST' })
    ok('停止转播', stop.status === 200)
    const s3 = await (await fetch(base + '/api/status')).json()
    ok('回到 idle', s3.mode === 'idle')

    ok('CORS 头', (await get('/api/status')).headers.get('access-control-allow-origin') === '*')
  } catch (e) {
    console.error('smoke error: ' + e.message)
    results.push(['异常', false])
  } finally {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
  const failed = results.filter(([, c]) => !c)
  console.log(String.fromCharCode(10) + (failed.length ? 'SMOKE FAILED: ' + failed.map(([n]) => n).join(', ') : 'SMOKE PASSED (' + results.length + ' checks)'))
  process.exit(failed.length ? 1 : 0)
}

main()
