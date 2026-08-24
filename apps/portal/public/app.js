// 门户逻辑：每 3s 轮询两后端 /api/status，iframe 分页签，一键停止
'use strict'
const $ = (sel) => document.querySelector(sel)
const HOST = location.hostname
const BACKENDS = {
  video: { label: '📺 视频转播站', port: 8100, url: () => `http://${HOST}:8100` },
  audio: { label: '📻 电台转播站', port: 8000, url: () => `http://${HOST}:8000` },
}
let activeTab = 'video'

async function fetchStatus(key, timeoutMs = 2500) {
  try {
    const r = await fetch(`${BACKENDS[key].url()}/api/status`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) throw new Error('http ' + r.status)
    return { online: true, data: await r.json() }
  } catch {
    return { online: false, data: null }
  }
}

function fmtUptime(s) {
  if (!s && s !== 0) return '-'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's'
}

function card(key, info) {
  const el = document.createElement('div')
  el.className = 'card ' + (info.online ? 'ok' : 'off')
  const b = BACKENDS[key]
  const head = document.createElement('div')
  head.className = 'card-head'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const title = document.createElement('span')
  title.className = 'card-title'
  title.textContent = b.label
  head.append(dot, title)
  el.append(head)
  const meta = document.createElement('div')
  meta.className = 'muted'
  if (info.online) {
    const d = info.data
    const bits = [`v${d.version || '?'}`, `端口 ${b.port}`, `运行 ${fmtUptime(d.uptime)}`]
    if (d.mode !== undefined) bits.push(d.mode === 'relay' ? '转播中' : '空闲')
    if (d.mediamtx && d.mediamtx.running !== undefined) bits.push('MediaMTX ' + (d.mediamtx.running ? '✓' : '✗'))
    meta.textContent = bits.join(' · ')
  } else {
    meta.textContent = '离线（双击 start-' + key + '.bat 启动）'
  }
  el.append(meta)
  const acts = document.createElement('div')
  acts.className = 'card-actions'
  const open = document.createElement('button')
  open.className = 'btn'
  open.textContent = '打开面板'
  open.onclick = () => window.open(b.url(), '_blank')
  const stop = document.createElement('button')
  stop.className = 'btn danger'
  stop.textContent = '停止'
  stop.disabled = !info.online
  stop.onclick = async () => {
    if (!confirm('停止 ' + b.label + '？')) return
    try {
      await fetch(`${b.url()}/api/shutdown`, { method: 'POST' })
    } catch { /* 已停止或网络失败 */ }
    setTimeout(refresh, 1500)
  }
  acts.append(open, stop)
  el.append(acts)
  return el
}

async function refresh() {
  const [video, audio] = await Promise.all([fetchStatus('video'), fetchStatus('audio')])
  const box = $('#cards')
  box.innerHTML = ''
  box.append(card('video', video), card('audio', audio))
  const p = await fetch('/api/status').then((r) => r.json()).catch(() => ({}))
  $('#portalMeta').textContent = 'portal v' + (p.version || '?') + ' · ' + HOST
}

function switchTab(key) {
  activeTab = key
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === key))
  $('#frame').src = BACKENDS[key].url() + '/'
}

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab))
})

switchTab(activeTab)
refresh()
setInterval(refresh, 3000)
