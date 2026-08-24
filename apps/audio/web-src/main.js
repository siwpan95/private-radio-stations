const $ = (id) => document.getElementById(id)
let currentMount = null

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show')
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 1800)
}
async function api(path, opts) {
  const r = await fetch(path, opts)
  if (!r.ok) throw new Error((await r.text()) || r.status)
  return r.json()
}

function fmtUp(sec) {
  const m = Math.floor((sec || 0) / 60)
  return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60) + 'm' : m + 'm'
}

async function refresh() {
  try {
    const s = await api('/api/status')
    const pill = $('modePill')
    pill.textContent = s.mode === 'relay' ? 'RELAY' : 'IDLE'
    pill.className = 'status-pill ' + (s.mode === 'relay' ? 'pill-relay' : 'pill-idle')
    $('nowPlaying').textContent = s.mode === 'relay' && s.current
      ? `正在转播：${s.current.name}  (${s.current.url})` : '空闲中 — 未转播'
    $('ffmpegState').textContent = s.ffmpeg ? 'ffmpeg ✓' : 'ffmpeg ✗'
    $('startBtn').disabled = s.mode === 'relay'
    $('stopBtn').disabled = s.mode !== 'relay'

    // 运行健康（/api/status 的运营字段）
    const h = []
    h.push('运行 ' + fmtUp(s.uptime))
    h.push('ffmpeg 子进程 ' + (s.ffmpeg_children ?? 0))
    if (s.hls && s.hls.latest_segment_age_s != null) {
      const age = s.hls.latest_segment_age_s
      h.push('HLS 段龄 ' + age + 's' + (age > 8 ? ' ⚠' : ''))
    }
    if (s.recent_errors && s.recent_errors.length) h.push('错误 ' + s.recent_errors.length + ' 条')
    h.push('v' + (s.version || '?'))
    $('healthLine').textContent = h.join(' · ')

    // HLS player visibility
    $('hlsPlayerWrap').style.display = (s.hls_url && s.mode === 'relay') ? 'block' : 'none'
    if (s.hls_url && s.mode === 'relay') {
      const ha = $('hlsAudio')
      if (ha.dataset.src !== s.hls_url) { ha.src = s.hls_url; ha.dataset.src = s.hls_url }
    }

    // mounts
    const m = $('mounts'); m.innerHTML = ''
    ;(s.mounts || []).forEach((k) => {
      const el = document.createElement('div')
      el.className = 'mount' + (currentMount === k ? ' active' : '')
      el.textContent = k + 'k'
      el.onclick = () => selectMount(k)
      m.appendChild(el)
    })
    if (!currentMount && s.mode === 'relay') selectMount(null)
  } catch (e) { toast('状态刷新失败：' + e.message) }
}

function selectMount(k) {
  currentMount = k
  const a = $('mainAudio')
  if (k) a.src = `/stream/${k}`; else a.src = '/stream'
  document.querySelectorAll('.mount').forEach((el) => {
    el.classList.toggle('active', String(k) === el.textContent.replace('k', ''))
  })
}

$('startBtn').onclick = async () => {
  const url = $('relayUrl').value.trim()
  if (!url) return toast('请填写音频流地址')
  const fallbacks = $('relayFallback').value.split('\n').map((s) => s.trim()).filter(Boolean)
  try {
    await api('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name: $('relayName').value.trim(), fallbacks }),
    })
    toast('转播已启动')
    await refresh()
  } catch (e) { toast('启动失败：' + e.message) }
}

$('stopBtn').onclick = async () => {
  try { await api('/api/relay/stop', { method: 'POST' }); currentMount = null
    toast('已停止'); await refresh() } catch (e) { toast('停止失败：' + e.message) }
}

$('browseBtn').onclick = async () => {
  const q = $('browseQuery').value.trim()
  if (!q) return toast('请输入搜索词')
  try {
    const { results } = await api('/api/browse?q=' + encodeURIComponent(q))
    const ul = $('browseList'); ul.innerHTML = ''
    if (!results.length) { ul.innerHTML = '<li class="hint">无结果</li>'; return }
    results.forEach((r) => {
      const li = document.createElement('li')
      li.innerHTML = `<div><div class="name">${esc(r.name)}</div>
        <div class="meta">${esc(r.country||'')} · ${esc(r.genre||'')} · ${r.bitrate||'?'}kbps · ${esc(r.codec||'')}</div></div>`
      const acts = document.createElement('div'); acts.className = 'actions'
      const b = document.createElement('button'); b.textContent = '转播'
      b.onclick = async () => {
        $('relayUrl').value = r.url; $('relayName').value = r.name
        await $('startBtn').onclick()
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
      acts.appendChild(b); li.appendChild(acts); ul.appendChild(li)
    })
  } catch (e) { toast('搜索失败：' + e.message) }
}

async function loadPresets() {
  try {
    const { presets } = await api('/api/presets')
    const ul = $('presetList'); ul.innerHTML = ''
    presets.forEach((p) => {
      const li = document.createElement('li')
      li.innerHTML = `<div><div class="name">${esc(p.name)}</div>
        <div class="meta">${esc(p.url)}</div></div>`
      const acts = document.createElement('div'); acts.className = 'actions'
      const go = document.createElement('button'); go.textContent = '转播'
      go.onclick = async () => { $('relayUrl').value = p.url; $('relayName').value = p.name; await $('startBtn').onclick() }
      const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '删除'
      del.onclick = async () => { await api('/api/presets?url=' + encodeURIComponent(p.url), { method: 'DELETE' }); await loadPresets() }
      acts.append(go, del); li.appendChild(acts); ul.appendChild(li)
    })
  } catch (e) { toast('预设加载失败：' + e.message) }
}

$('presetAdd').onclick = async () => {
  const name = $('presetName').value.trim(), url = $('presetUrl').value.trim()
  if (!name || !url) return toast('请填写预设名称与地址')
  await api('/api/presets', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name, url }) })
  $('presetName').value = ''; $('presetUrl').value = ''
  await loadPresets(); toast('预设已添加')
}

$('copyBtn').onclick = () => {
  $('shareUrl').select(); document.execCommand('copy'); toast('已复制')
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }

// visualizer for main player
const ac = new (window.AudioContext || window.webkitAudioContext)()
let srcNode = null, analyser = null, data = null
function setupViz(audioEl) {
  if (srcNode) try { srcNode.disconnect() } catch {}
  srcNode = ac.createMediaElementSource(audioEl)
  analyser = ac.createAnalyser(); analyser.fftSize = 256
  data = new Uint8Array(analyser.frequencyBinCount)
  srcNode.connect(analyser); analyser.connect(ac.destination)
  draw()
}
let vizOn = false
function draw() {
  if (!analyser) return requestAnimationFrame(draw)
  const cv = $('viz'), ctx = cv.getContext('2d')
  cv.width = cv.clientWidth; cv.height = 54
  const render = () => {
    requestAnimationFrame(render)
    analyser.getByteFrequencyData(data)
    ctx.clearRect(0,0,cv.width,cv.height)
    const bw = cv.width / data.length
    for (let i=0;i<data.length;i++){
      const h = (data[i]/255)*cv.height
      ctx.fillStyle = `hsl(${200 + i/data.length*60},80%,60%)`
      ctx.fillRect(i*bw, cv.height-h, bw-1, h)
    }
  }
  render()
}
$('mainAudio').addEventListener('play', () => { if (!vizOn) { setupViz($('mainAudio')); vizOn = true } ac.resume() })

// ===== 设置（P9 分层设置：防抖自动保存 + 409 乐观回滚）=====
let settingsRev = 0, settingsTimer = null

async function loadSettings() {
  try {
    const s = await api('/api/settings/audio.relay')
    if (!s.value) return
    settingsRev = s.revision
    $('setBitrate').value = s.value.defaultBitrate
    $('settingsState').textContent = 'rev ' + settingsRev
  } catch (e) { $('settingsState').textContent = '加载失败' }
}

async function saveSettings() {
  const bitrate = Math.min(512, Math.max(8, Number($('setBitrate').value) || 128))
  $('setBitrate').value = bitrate
  try {
    const r = await api('/api/settings/audio.relay', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { defaultBitrate: bitrate }, expectedRevision: settingsRev }),
    })
    settingsRev = r.revision
    $('settingsState').textContent = '✅ 已保存 rev ' + settingsRev
  } catch (e) {
    // 409 冲突或失败：提示并重载（乐观回滚）
    toast('设置冲突或保存失败，已刷新')
    await loadSettings()
  }
}

$('setBitrate').addEventListener('input', () => {
  $('settingsState').textContent = '保存中…'
  clearTimeout(settingsTimer)
  settingsTimer = setTimeout(saveSettings, 400)
})

// init
$('shareUrl').value = location.origin
loadPresets(); refresh(); loadSettings()
setInterval(refresh, 5000)
