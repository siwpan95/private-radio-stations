// channels plugin — IPTV m3u 频道库：解析 / 导入 / 删除 playlists/*.m3u8。
// 同一频道名下多个源合并为 urls[]：转播时第一个为主源，其余作为 failover
// 备用源交给 station（与电台项目的多源切换同机制）。
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024 // 导入上限 10MB

// 解析 m3u/m3u8 文本，同名频道合并多源。
export function parseM3u(text) {
  const channels = new Map() // key -> { name, group, logo, tvgId, rt, urls: [] }
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const m = line.match(/#EXTINF:[^,]*,([\s\S]*)$/)
      const full = (m ? m[1] : '未命名').trim()
      // "CCTV-2 (720p)" 与 "CCTV-2" 归并到同一频道
      const name = full.replace(/\s*\(\d+p\)\s*$/, '').trim()
      const tvgId = (line.match(/tvg-id="([^"]*)"/) || [])[1] || ''
      const logo = (line.match(/tvg-logo="([^"]*)"/) || [])[1] || ''
      const group = (line.match(/group-title="([^"]*)"/) || [])[1] || ''
      const rt = (line.match(/response-time="([^"]*)"/) || [])[1] || ''
      let ch = channels.get(name)
      if (!ch) {
        ch = { name, group, logo, tvgId, rt, urls: [] }
        channels.set(name, ch)
      } else {
        if (!ch.group) ch.group = group
        if (!ch.logo) ch.logo = logo
        if (!ch.tvgId) ch.tvgId = tvgId
      }
      cur = ch
      continue
    }
    if (line.startsWith('#')) continue
    if (cur && /^(https?:|rtsp:|rtmp:|udp:|rtp:)/i.test(line)) {
      if (!cur.urls.includes(line)) cur.urls.push(line)
      cur = null
    }
  }
  return [...channels.values()].filter((c) => c.urls.length > 0)
}

class ChannelsService extends Service {
  constructor(ctx) {
    super(ctx, 'channels')
  }

  get dir() {
    const d = path.resolve(this.ctx.config.root, this.ctx.config.channelsDir || 'playlists')
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
    return d
  }

  safeFile(file) {
    const name = path.basename(String(file || ''))
    if (!/\.(m3u8?)$/i.test(name) || name.includes('..')) return null
    return name
  }

  files() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => /\.(m3u8?)$/i.test(f))
        .map((f) => {
          const s = fs.statSync(path.join(this.dir, f))
          let channels = 0
          try { channels = parseM3u(fs.readFileSync(path.join(this.dir, f), 'utf8')).length } catch { /* ignore */ }
          return { file: f, size: s.size, mtimeMs: s.mtimeMs, channels }
        })
        .sort((a, b) => a.file.localeCompare(b.file))
    } catch {
      return []
    }
  }

  get(file) {
    const name = this.safeFile(file)
    if (!name) return []
    try {
      return parseM3u(fs.readFileSync(path.join(this.dir, name), 'utf8'))
    } catch {
      return []
    }
  }

  // 从 URL 导入播放列表（校验 #EXTM3U 且至少一个频道）
  async importFromUrl(url, name) {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'URL 需以 http(s):// 开头' }
    let text
    try {
      const resp = await fetch(u, { signal: AbortSignal.timeout(30000), redirect: 'follow' })
      if (!resp.ok) return { ok: false, error: '下载失败 HTTP ' + resp.status }
      text = await resp.text()
    } catch (e) {
      return { ok: false, error: '下载失败：' + e.message }
    }
    if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: '文件过大（>10MB）' }
    if (!/#EXTM3U/i.test(text)) return { ok: false, error: '不是合法的 m3u/m3u8 播放列表' }
    const parsed = parseM3u(text)
    if (!parsed.length) return { ok: false, error: '列表里没有可识别的频道' }
    let base = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\.(m3u8?)$/i, '')
    if (!base) {
      try { base = new URL(u).hostname } catch { base = 'imported' }
    }
    let file = base + '.m3u8'
    let n = 1
    while (fs.existsSync(path.join(this.dir, file))) {
      file = base + '_' + (++n) + '.m3u8'
    }
    fs.writeFileSync(path.join(this.dir, file), text)
    return { ok: true, file, channels: parsed.length }
  }

  remove(file) {
    const name = this.safeFile(file)
    if (!name) return false
    try {
      fs.rmSync(path.join(this.dir, name), { force: true })
      return true
    } catch {
      return false
    }
  }
}

ChannelsService.inject = ['config']

export default function channelsPlugin(ctx) {
  ctx.plugin(ChannelsService)
}
