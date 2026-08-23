/* 控制面板逻辑：每 2 秒拉 /api/status 渲染；动作走 fetch API */
'use strict'

const $ = (sel) => document.querySelector(sel)

let state = null
let lastCurrentKey = ''

function fmtBytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return n.toFixed(1) + ' ' + u[i]
}

function fmtUptime(s) {
  if (!s && s !== 0) return '-'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's'
}

function fmtTime(ms) {
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  return resp.json().catch(() => ({}))
}

function chip(label, ok, extra) {
  const el = document.createElement('span')
  el.className = 'chip ' + (ok ? 'ok' : 'bad')
  el.textContent = label + (extra !== undefined ? ' · ' + extra : '')
  return el
}

function renderChips(s) {
  const box = $('#chips')
  box.innerHTML = ''
  box.append(chip('MediaMTX', s.mediamtx.running,
    s.mediamtx.api ? (s.mediamtx.api.ready ? '路径就绪 · 连接 ' + s.mediamtx.api.readers : '路径未就绪') : 'API 不可达'))
  box.append(chip('ffmpeg 拉流', s.streamer.running, s.streamer.running ? '推流中' : '停止'))
  box.append(chip('录像', s.recorder.running, s.recorder.running ? fmtBytes(s.recorder.bytes) : '停止'))
  box.append(chip('失败次数', s.failureCount === 0, s.failureCount))
  box.append(chip('运行时长', true, fmtUptime(s.uptime)))
}

function renderCurrent(s) {
  const box = $('#current-info')
  if (s.mode === 'relay' && s.current) {
    box.classList.remove('hidden')
    box.querySelector('.ci-name').textContent = '正在转播：' + s.current.name + (s.current.transcode ? '（转码 H.264）' : '（原码流）') + (s.current.record ? '（录像中）' : '')
    box.querySelector('.ci-url').textContent = s.current.url + (s.sourceCount > 1 ? '   [备用源 ' + (s.sourceCount - 1) + ' 个]' : '')
  } else {
    box.classList.add('hidden')
  }
}

function renderError(s) {
  const box = $('#error-box')
  if (s.error) {
    box.classList.remove('hidden')
    box.textContent = '⚠ ' + s.error
  } else {
    box.classList.add('hidden')
  }
}

function renderMode(s) {
  const b = $('#mode-badge')
  b.className = 'badge ' + (s.mode === 'relay' ? 'relay' : 'idle')
  b.textContent = s.mode === 'relay' ? '转播中' : '空闲'
}

function renderPlayer(s) {
  const wrap = $('#player-wrap')
  const idle = $('#player-idle')
  const key = s.mode === 'relay' ? (s.urls && s.urls.webrtcLocal) : ''
  if (key && key !== lastCurrentKey) {
    // 换源/开始转播时才重载 iframe，避免每 2s 刷新打断播放
    $('#player').src = key
    lastCurrentKey = key
  }
  if (s.mode === 'relay' && s.urls) {
    wrap.classList.remove('hidden')
    idle.classList.add('hidden')
  } else {
    wrap.classList.add('hidden')
    idle.classList.remove('hidden')
    lastCurrentKey = ''
    $('#player').src = 'about:blank'
  }
}

function linkButton(text, url, copy) {
  const el = document.createElement('div')
  el.className = 'link-item'
  const b = document.createElement('button')
  b.className = 'btn small ' + (copy ? 'primary' : '')
  b.textContent = text
  b.title = url
  if (copy) {
    b.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard) throw new Error('no clipboard')
        await navigator.clipboard.writeText(url)
        b.textContent = '✅ 已复制'
        setTimeout(() => { b.textContent = text }, 1200)
      } catch {
        window.prompt('复制失败，请手动复制：', url)
      }
    })
  } else {
    b.addEventListener('click', () => window.open(url, '_blank'))
  }
  el.append(b)
  const code = document.createElement('code')
  code.textContent = url
  code.title = url
  el.append(code)
  return el
}

function renderLinks(s) {
  const box = $('#links')
  box.innerHTML = ''
  if (s.mode !== 'relay' || !s.urls) {
    const hint = document.createElement('div')
    hint.className = 'muted'
    hint.textContent = '开始转播后显示观看地址。'
    box.append(hint)
    return
  }
  const u = s.urls
  const btn = (label, url, copy) => {
    const b = document.createElement('button')
    b.className = 'btn small ' + (copy ? 'primary' : '')
    b.textContent = label
    b.addEventListener('click', () => {
      if (!copy) return window.open(url, '_blank')
      const doCopy = () => navigator.clipboard.writeText(url).then(() => { b.textContent = '✅ 已复制'; setTimeout(() => { b.textContent = label }, 1200) }).catch(() => window.prompt('手动复制：', url))
      if (navigator.clipboard) doCopy()
      else window.prompt('手动复制：', url)
    })
    return b
  }
  const row = document.createElement('div')
  row.className = 'links-row'
  row.append(btn('复制 RTSP', u.rtsp, true), btn('复制 HLS', u.hls, true), btn('打开 WebRTC 页', u.webrtc, false))
  box.append(row)
  box.append(linkButton('RTSP（VLC / PotPlayer / mpv / 手机）', u.rtsp, false))
  box.append(linkButton('HLS（网页 / 手机）', u.hls, false))
  box.append(linkButton('WebRTC（浏览器低延迟）', u.webrtc, false))
  const tip = document.createElement('div')
  tip.className = 'muted'
  tip.innerHTML = '播放方法：VLC「打开网络串流」粘贴 RTSP；PotPlayer Ctrl+U；mpv 命令行 <code>mpv "' + u.rtsp + '"</code>。'
  box.append(tip)
}

function renderPresets(s) {
  const box = $('#presets')
  box.innerHTML = ''
  if (!s.presets || !s.presets.length) {
    box.innerHTML = '<div class="muted">暂无预设。用上方表单添加，或直接编辑项目根目录 presets.json。</div>'
    return
  }
  const activeUrl = s.mode === 'relay' && s.current ? s.current.url : null
  for (const p of s.presets) {
    const item = document.createElement('div')
    item.className = 'preset' + (p.url === activeUrl ? ' active' : '')
    const body = document.createElement('div')
    body.className = 'preset-body'
    body.innerHTML = ''
    const icon = document.createElement('span')
    icon.className = 'preset-icon'
    icon.textContent = p.icon || '📡'
    const info = document.createElement('div')
    info.className = 'preset-info'
    const nm = document.createElement('div')
    nm.className = 'preset-name'
    nm.textContent = p.name
    const de = document.createElement('div')
    de.className = 'preset-desc muted'
    de.textContent = p.desc || p.url
    info.append(nm, de)
    body.append(icon, info)
    body.addEventListener('click', async () => {
      const r = document.getElementById('r-transcode')
      const rec = document.getElementById('r-record')
      await api('/api/relay', {
        method: 'POST',
        body: JSON.stringify({ url: p.url, name: p.name, transcode: r.checked, record: rec.checked }),
      })
      refresh()
    })
    const del = document.createElement('button')
    del.className = 'preset-del'
    del.textContent = '✕'
    del.title = '删除预设'
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      await api('/api/presets?url=' + encodeURIComponent(p.url), { method: 'DELETE' })
      refresh()
    })
    item.append(body, del)
    box.append(item)
  }
}

function renderRecordings(s) {
  const tbody = $('#recs tbody')
  tbody.innerHTML = ''
  if (!s.recordings || !s.recordings.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">暂无录像</td></tr>'
    return
  }
  for (const r of s.recordings) {
    const tr = document.createElement('tr')
    const td1 = document.createElement('td')
    td1.textContent = r.name
    const td2 = document.createElement('td')
    td2.textContent = fmtBytes(r.size)
    const td3 = document.createElement('td')
    td3.textContent = fmtTime(r.mtimeMs)
    const td4 = document.createElement('td')
    const dl = document.createElement('button')
    dl.className = 'btn tiny'
    dl.textContent = '下载'
    dl.addEventListener('click', () => window.open('/recordings/' + encodeURIComponent(r.name), '_blank'))
    const rm = document.createElement('button')
    rm.className = 'btn tiny danger'
    rm.textContent = '删除'
    rm.addEventListener('click', async () => {
      if (!confirm('删除 ' + r.name + '？')) return
      await api('/api/recordings?name=' + encodeURIComponent(r.name), { method: 'DELETE' })
      refresh()
    })
    td4.append(dl, rm)
    tr.append(td1, td2, td3, td4)
    tbody.append(tr)
  }
}

function render(s) {
  state = s
  $('#version').textContent = 'v' + (s.version || '?')
  renderMode(s)
  renderChips(s)
  renderCurrent(s)
  renderError(s)
  renderPlayer(s)
  renderLinks(s)
  renderPresets(s)
  renderRecordings(s)
  $('#btn-record').textContent = s.recorder.running ? '⏹ 停止录像' : '⏺ 开始录像'
  $('#btn-start').disabled = s.mode === 'relay'
  $('#btn-stop').disabled = s.mode !== 'relay'
}

async function refresh() {
  try {
    const s = await api('/api/status')
    render(s)
  } catch (e) {
    // 服务器未就绪：什么都不做，等下次轮询
  }
}

// ===== 频道库（IPTV m3u）=====
let channelFile = ''
let channelSearch = ''
let channelCache = []

async function loadChannelFiles() {
  const s = await api('/api/channels')
  const sel = $('#ch-file')
  const cur = channelFile
  sel.innerHTML = ''
  for (const p of (s.playlists || [])) {
    const opt = document.createElement('option')
    opt.value = p.file
    opt.textContent = p.file + '（' + p.channels + ' 频道）'
    sel.append(opt)
  }
  if (cur && s.playlists.some((p) => p.file === cur)) channelFile = cur
  else channelFile = s.playlists.length ? s.playlists[0].file : ''
  sel.value = channelFile
}

async function loadChannels() {
  const s = await api('/api/channels?file=' + encodeURIComponent(channelFile))
  channelCache = s.channels || []
  renderChannels()
}

function renderChannels() {
  const box = $('#channels')
  box.innerHTML = ''
  if (!channelCache.length) {
    box.innerHTML = '<div class="muted">当前列表没有频道。可导入新的 m3u/m3u8 播放列表。</div>'
    return
  }
  const q = channelSearch.trim().toLowerCase()
  const list = q ? channelCache.filter((c) => c.name.toLowerCase().includes(q)) : channelCache
  if (!list.length) {
    box.innerHTML = '<div class="muted">没有匹配的频道。</div>'
    return
  }
  const activeUrl = state && state.mode === 'relay' && state.current ? state.current.url : null
  for (const c of list.slice(0, 300)) {
    const item = document.createElement('div')
    item.className = 'channel' + (activeUrl && c.urls.includes(activeUrl) ? ' active' : '')
    const info = document.createElement('div')
    info.className = 'channel-body'
    const grp = document.createElement('span')
    grp.className = 'chip'
    grp.textContent = c.group || '未分组'
    const nm = document.createElement('span')
    nm.className = 'channel-name'
    nm.textContent = c.name
    const src = document.createElement('span')
    src.className = 'muted'
    src.textContent = c.urls.length + ' 源'
    info.append(grp, nm, src)
    info.addEventListener('click', async () => {
      const t = document.getElementById('r-transcode')
      const rec = document.getElementById('r-record')
      await api('/api/relay', {
        method: 'POST',
        body: JSON.stringify({ url: c.urls[0], name: c.name, fallbacks: c.urls.slice(1), transcode: t.checked, record: rec.checked }),
      })
      refresh()
    })
    const btn = document.createElement('button')
    btn.className = 'btn tiny primary'
    btn.textContent = '▶'
    btn.title = '转播（' + c.urls.length + ' 个源，自动切换）'
    btn.addEventListener('click', async () => {
      const t = document.getElementById('r-transcode')
      const rec = document.getElementById('r-record')
      await api('/api/relay', {
        method: 'POST',
        body: JSON.stringify({ url: c.urls[0], name: c.name, fallbacks: c.urls.slice(1), transcode: t.checked, record: rec.checked }),
      })
      refresh()
    })
    item.append(info, btn)
    box.append(item)
  }
}

// ===== 平台直播解析（real-url）=====
let platforms = []

async function loadPlatforms() {
  const s = await api('/api/platforms')
  platforms = s.platforms || []
  const sel = $('#rs-platform')
  sel.innerHTML = ''
  for (const p of platforms) {
    const opt = document.createElement('option')
    opt.value = p.module
    opt.textContent = p.hot ? '⭐ ' + p.label : p.label
    sel.append(opt)
  }
  updatePlatformHint()
}

function updatePlatformHint() {
  const p = platforms.find((x) => x.module === $('#rs-platform').value)
  const hint = $('#rs-hint')
  hint.textContent = p
    ? (p.hint ? '提示：' + p.hint + (p.example ? '（例：' + p.example + '）' : '') : '')
    : ''
}

async function doResolve() {
  const platform = $('#rs-platform').value
  const room = $('#rs-room').value.trim()
  const out = $('#rs-result')
  if (!room) { out.textContent = '请填写房间号/频道名/分享链接'; return }
  out.textContent = '解析中…'
  const t = document.getElementById('r-transcode')
  const rec = document.getElementById('r-record')
  const r = await api('/api/relay/resolve', {
    method: 'POST',
    body: JSON.stringify({ platform, room, transcode: t.checked, record: rec.checked }),
  })
  if (r.resolved) {
    out.textContent = '✅ 已解析并开始转播：' + r.resolved.url
  } else {
    out.textContent = '❌ ' + (r.error || '解析失败')
  }
  refresh()
}

function bindEvents() {
  $('#relay-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const url = $('#r-url').value.trim()
    if (!url) { alert('请填写流地址'); return }
    const fallbacks = $('#r-fallbacks').value.split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean)
    await api('/api/relay', {
      method: 'POST',
      body: JSON.stringify({
        url,
        name: $('#r-name').value.trim(),
        fallbacks,
        transcode: $('#r-transcode').checked,
        record: $('#r-record').checked,
      }),
    })
    refresh()
  })

  $('#btn-stop').addEventListener('click', async () => {
    await api('/api/relay/stop', { method: 'POST' })
    refresh()
  })

  $('#btn-record').addEventListener('click', async () => {
    const on = !(state && state.recorder && state.recorder.running)
    await api('/api/record', { method: 'POST', body: JSON.stringify({ on }) })
    refresh()
  })

  $('#preset-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const url = $('#p-url').value.trim()
    if (!url) { alert('请填写流地址'); return }
    await api('/api/presets', {
      method: 'POST',
      body: JSON.stringify({ name: $('#p-name').value.trim(), url, icon: '📡' }),
    })
    $('#p-name').value = ''
    $('#p-url').value = ''
    refresh()
  })

  $('#ch-file').addEventListener('change', async () => {
    channelFile = $('#ch-file').value
    channelSearch = ''
    $('#ch-search').value = ''
    await loadChannels()
  })

  $('#ch-search').addEventListener('input', () => {
    channelSearch = $('#ch-search').value
    renderChannels()
  })

  $('#ch-del').addEventListener('click', async () => {
    if (!channelFile) return
    if (!confirm('删除播放列表 ' + channelFile + '？')) return
    await api('/api/playlist?file=' + encodeURIComponent(channelFile), { method: 'DELETE' })
    channelFile = ''
    await loadChannelFiles()
    await loadChannels()
  })

  $('#playlist-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const url = $('#pl-url').value.trim()
    if (!url) { alert('请填写 m3u/m3u8 地址'); return }
    const r = await api('/api/playlist', {
      method: 'POST',
      body: JSON.stringify({ url, name: $('#pl-name').value.trim() }),
    })
    if (r.ok) {
      channelFile = r.file
      channelSearch = ''
      $('#ch-search').value = ''
      $('#pl-url').value = ''
      $('#pl-name').value = ''
      await loadChannelFiles()
      await loadChannels()
    } else {
      alert('导入失败：' + (r.error || '未知错误'))
    }
  })

  $('#rs-platform').addEventListener('change', updatePlatformHint)

  $('#resolve-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    await doResolve()
  })
}

bindEvents()
refresh()
loadPlatforms()
loadChannelFiles().then(() => loadChannels())
setInterval(refresh, 2000)
