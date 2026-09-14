#!/usr/bin/env node
/**
 * localplayer-bridge.mjs —— 把 private-radio-stations 的媒体源聚合成
 * 「轻量播放器」扩展认识的清单契约，让浏览器扩展可以直接当本项目的播放器用。
 *
 * 契约（扩展侧消费）：
 *   GET /api/list   -> [ { name, path, type: 'audio'|'video', source, remote } ]
 *   GET /api/health -> { ok, config, sources: [ { id, label, ok, count, error } ] }
 *   GET /           -> 说明页
 *
 * 设计红线：
 *   1. **任一上游没起来都不影响别人** —— 每个源独立超时、独立 try/catch，
 *      挂了的源只是不出现在清单里（`/api/health` 里给原因），全挂就返回空数组，
 *      扩展会按自己的 fallback 链回落到本地打包媒体。
 *   2. **只做播放，不做控制** —— 不调用 /api/relay/start 之类的写接口，
 *      启停转播仍然在 radio / video 各自的面板上做。
 *   3. **只监听 127.0.0.1** —— 不往局域网暴露。
 *
 * 运行：
 *   node scripts/localplayer-bridge.mjs
 *   # 或 npm run bridge
 *
 * 环境变量（都有默认值）：
 *   LP_BRIDGE_PORT   8787   本桥监听端口
 *   LP_AUDIO_BASE    http://127.0.0.1:8000   audio 应用
 *   LP_VIDEO_BASE    http://127.0.0.1:8100   video 应用
 *   LP_MTX_BASE      http://127.0.0.1:8888   MediaMTX（HLS）
 *   LP_MTX_PATH      live                    MediaMTX 转播路径名
 *   LP_MAX_CHANNELS  200                     IPTV 频道最多列多少条
 *   LP_MAX_PRESETS   100                     电台预设最多列多少条
 *   LP_TIMEOUT_MS    1500                    每个上游的探测超时
 */
import http from 'node:http'

const PORT = Number(process.env.LP_BRIDGE_PORT || 8787)
const AUDIO = (process.env.LP_AUDIO_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const VIDEO = (process.env.LP_VIDEO_BASE || 'http://127.0.0.1:8100').replace(/\/+$/, '')
const MTX = (process.env.LP_MTX_BASE || 'http://127.0.0.1:8888').replace(/\/+$/, '')
const MTX_PATH = (process.env.LP_MTX_PATH || 'live').replace(/^\/+|\/+$/g, '')
const MAX_CHANNELS = Number(process.env.LP_MAX_CHANNELS || 200)
const MAX_PRESETS = Number(process.env.LP_MAX_PRESETS || 100)
const TIMEOUT_MS = Number(process.env.LP_TIMEOUT_MS || 1500)

/* Chromium 能直接解码的容器。注意 **.ts（MPEG-TS）不在内** ——
 * video 的 recorder 目前录出来就是 .ts，Chromium 没有原生 MPEG-TS 解码器，
 * 列进去只会得到一个「点开无声无画」的条目，所以这里直接过滤掉。
 * 等录制改成 mp4/mkv 后无需改代码，会自动出现在清单里。 */
const PLAYABLE_VIDEO = /\.(mp4|m4v|webm|mov|mkv)$/i

function timeoutSignal(ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, done: () => clearTimeout(t) }
}

async function getJson(url) {
  const { signal, done } = timeoutSignal(TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal, cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    done()
  }
}

/** 只探活，不下载正文（HLS 清单可能很大）。返回 { ok, reason } ——
 *  区分「连不上」（上游没起）与「连上了但没这个流」（HTTP 404），
 *  这两种在排查时是完全不同的结论。 */
async function probe(url) {
  const { signal, done } = timeoutSignal(TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal, method: 'GET', cache: 'no-store' })
    // 读一小段就丢掉，避免把整段流拽下来
    try { if (r.body) await r.body.cancel() } catch (_) { /* ignore */ }
    return { ok: r.ok, reason: r.ok ? null : `HTTP ${r.status}` }
  } catch (e) {
    return {
      ok: false,
      reason: e && e.name === 'AbortError' ? `超时 ${TIMEOUT_MS}ms` : '连接失败',
    }
  } finally {
    done()
  }
}

/** 从 {a:1} 或 {x:{a:1}} 里取 a —— 上游把字段放在哪一层不完全一致，容忍一下。 */
function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  if (obj[key] !== undefined) return obj[key]
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && v[key] !== undefined) return v[key]
  }
  return undefined
}

const SOURCES = [
  {
    id: 'audio.live',
    label: '音频转播流（/stream）',
    async get() {
      const st = await getJson(`${AUDIO}/api/status`)
      const mode = pick(st, 'mode')
      // 未转播时 /stream 是静音占位流，列出来只会让人以为坏了 —— 不列。
      if (mode !== 'relay') return []
      const cur = pick(st, 'current')
      const name = cur && cur.name ? String(cur.name) : ''
      return [{
        name: name ? `电台直播 · ${name}` : '电台直播',
        path: `${AUDIO}/stream`,
        type: 'audio',
        source: 'audio.live',
      }]
    },
  },
  {
    id: 'audio.hls',
    label: '音频 HLS（audio 应用自带）',
    async get() {
      const st = await getJson(`${AUDIO}/api/status`)
      if (pick(st, 'mode') !== 'relay') return []
      const hlsUrl = pick(st, 'hls_url')
      if (!hlsUrl) return [] // HLS 没开就跳过（config.hls.enabled=false）
      const path = hlsUrl.startsWith('http') ? hlsUrl : `${AUDIO}${hlsUrl.startsWith('/') ? '' : '/'}${hlsUrl}`
      return [{ name: '电台直播 · HLS', path, type: 'audio', source: 'audio.hls' }]
    },
  },
  {
    id: 'audio.presets',
    label: '电台预设（直接播放，无需转播）',
    async get() {
      const r = await getJson(`${AUDIO}/api/presets`)
      const list = Array.isArray(r) ? r : (Array.isArray(r?.presets) ? r.presets : [])
      return list
        .filter((p) => p && p.url)
        .slice(0, MAX_PRESETS)
        .map((p) => ({
          name: String(p.name || p.url),
          path: String(p.url),
          type: 'audio',
          source: 'audio.presets',
        }))
    },
  },
  {
    id: 'video.hls',
    label: 'MediaMTX HLS 直播',
    async get() {
      const url = `${MTX}/${MTX_PATH}/index.m3u8`
      const p = await probe(url)
      if (p.ok) return [{ name: '本地直播（HLS）', path: url, type: 'video', source: 'video.hls' }]
      // 连不上 MediaMTX 才是「错误」；连上了但没在推流（404）只是「当前没有」，
      // 别把正常状态报成故障，否则体检页会一直红。
      if (p.reason !== 'HTTP 404') throw new Error(`MediaMTX 不可达（${p.reason}）`)
      return []
    },
  },
  {
    id: 'video.channels',
    label: 'IPTV 频道库',
    async get() {
      const r = await getJson(`${VIDEO}/api/channels`)
      const list = Array.isArray(r?.channels) ? r.channels : []
      return list
        .filter((c) => c && Array.isArray(c.urls) && c.urls[0])
        .slice(0, MAX_CHANNELS)
        .map((c) => ({
          name: c.group ? `${c.group} · ${c.name}` : String(c.name || c.urls[0]),
          path: String(c.urls[0]),
          type: 'video',
          source: 'video.channels',
        }))
    },
  },
  {
    id: 'video.recordings',
    label: '录制回放（仅 Chromium 可解的容器）',
    async get() {
      const r = await getJson(`${VIDEO}/api/recordings`)
      const list = Array.isArray(r?.recordings) ? r.recordings : []
      return list
        .filter((f) => f && PLAYABLE_VIDEO.test(String(f.name || '')))
        .map((f) => ({
          name: `录制 · ${f.name}`,
          path: `${VIDEO}/recordings/${encodeURIComponent(String(f.name))}`,
          type: 'video',
          source: 'video.recordings',
        }))
    },
  },
]

/**
 * 汇总。刻意**并发**跑所有源：任何一个源慢/挂，都由它自己的超时收住，
 * 不会拖长整清单的响应时间。结果按 SOURCES 声明顺序排列（稳定性 > 到达顺序）。
 */
async function collect() {
  const health = []
  const byId = new Map()

  await Promise.all(SOURCES.map(async (s) => {
    const rec = { id: s.id, label: s.label, state: 'error', count: 0, error: null }
    try {
      const items = (await s.get()) || []
      rec.count = items.length
      /* state 三态是刻意区分的 —— 排查时最常问的就是「上游没起」还是
       * 「起了但没内容」，两者都显示成 ok/error 都会把人带偏：
       *   error = 请求失败（上游没起 / 超时）
       *   empty = 上游应答了，但这个源当前没有可列的东西（如没在转播、没频道）
       *   ok    = 至少列出一条 */
      rec.state = items.length ? 'ok' : 'empty'
      byId.set(s.id, items)
    } catch (e) {
      // 上游没起来是最常见的情况，给一句人话，不打堆栈
      rec.error = e && e.name === 'AbortError' ? `超时 ${TIMEOUT_MS}ms` : String(e && e.message || e)
    }
    health.push(rec)
  }))

  const items = []
  const seen = new Set()
  for (const s of SOURCES) {
    for (const it of byId.get(s.id) || []) {
      if (!it || !it.path || !it.type) continue
      if (seen.has(it.path)) continue // 同一个 URL 可能被多个源给出
      seen.add(it.path)
      // remote: true 让扩展把来源显示成「远端源」
      items.push({ ...it, remote: true })
    }
  }
  return { items, health: SOURCES.map((s) => health.find((h) => h.id === s.id)) }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>localplayer-bridge</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f0f12;color:#eaeef2;margin:2rem;line-height:1.7}
a{color:#7aa2f7}code{background:#1c1c22;padding:2px 6px;border-radius:4px}table{border-collapse:collapse;margin-top:1rem}
td,th{border:1px solid #2a2a33;padding:6px 10px;text-align:left;font-size:.9rem}</style></head>
<body><h1>localplayer-bridge</h1>
<p>把 private-radio-stations 的媒体源聚合成「轻量播放器」扩展的 <code>/api/list</code> 契约。</p>
<ul>
  <li><a href="/api/list">/api/list</a> — 媒体清单（扩展消费）</li>
  <li><a href="/api/health">/api/health</a> — 各上游的可用性与条目数（排查用）</li>
</ul>
<p>上游：audio <code>${AUDIO}</code> · video <code>${VIDEO}</code> · MediaMTX <code>${MTX}/${MTX_PATH}</code></p>
</body></html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  try {
    if (url.pathname === '/api/list') {
      const { items } = await collect()
      return sendJson(res, 200, items)
    }
    if (url.pathname === '/api/health') {
      const { items, health } = await collect()
      return sendJson(res, 200, {
        alive: true,               // 桥本身活着（能应答就是 true）
        hasMedia: items.length > 0, // 有没有列到任何可播的东西
        total: items.length,
        config: { AUDIO, VIDEO, MTX, MTX_PATH, MAX_CHANNELS, MAX_PRESETS, TIMEOUT_MS },
        sources: health,
      })
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(INDEX_HTML)
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204)
      return res.end()
    }
    sendJson(res, 404, { error: 'not found', paths: ['/api/list', '/api/health'] })
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`localplayer-bridge 已启动: http://127.0.0.1:${PORT}`)
  console.log(`  audio=${AUDIO}  video=${VIDEO}  mediamtx=${MTX}/${MTX_PATH}`)
  console.log(`  清单 /api/list   体检 /api/health`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
