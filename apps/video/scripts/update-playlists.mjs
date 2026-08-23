// update-playlists.mjs — 从镜像链更新 playlists/ 下的 IPTV 频道列表。
// 主镜像 jsdelivr（本机实测快且稳定），备镜像 ghfast.top；下载后校验 #EXTM3U 再原子替换。
// 用法：node scripts/update-playlists.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseM3u } from '../src/plugins/channels.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'playlists')

// 可扩展：新增列表时在 TARGETS 加一行即可
const TARGETS = [
  { out: 'cctv.m3u8', repo: 'best-fan/iptv-sources', file: 'cn_cctv.m3u8' },
  { out: 'province.m3u8', repo: 'best-fan/iptv-sources', file: 'cn_province.m3u8' },
  { out: 'all.m3u8', repo: 'best-fan/iptv-sources', file: 'cn_all.m3u8' },
  { out: 'pay.m3u8', repo: 'best-fan/iptv-sources', file: 'cn_pay.m3u8' },
]

// 镜像链：按顺序尝试，全部失败才报错
const MIRRORS = [
  {
    name: 'jsdelivr',
    url: (t) => `https://cdn.jsdelivr.net/gh/${t.repo}@main/${t.file}`,
  },
  {
    name: 'ghfast.top',
    url: (t) => `https://ghfast.top/https://raw.githubusercontent.com/${t.repo}/main/${t.file}`,
  },
  {
    name: 'github.akams.cn',
    url: (t) => `https://github.akams.cn/https://raw.githubusercontent.com/${t.repo}/main/${t.file}`,
  },
]

async function fetchText(url, timeoutMs = 30000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!resp.ok) throw new Error('HTTP ' + resp.status)
  const text = await resp.text()
  if (text.length > 20 * 1024 * 1024) throw new Error('文件过大')
  if (!/#EXTM3U/i.test(text)) throw new Error('不是合法播放列表')
  return text
}

let failures = 0
for (const t of TARGETS) {
  let done = false
  for (const m of MIRRORS) {
    try {
      const text = await fetchText(m.url(t))
      const channels = parseM3u(text).length
      if (!channels) throw new Error('没有可识别频道')
      const outPath = path.join(OUT, t.out)
      const tmp = outPath + '.tmp'
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, outPath)
      console.log(`OK   ${t.out}  <- ${m.name}  (${channels} 频道, ${(text.length / 1024).toFixed(1)}KB)`)
      done = true
      break
    } catch (e) {
      console.log(`     ${t.out}  尝试 ${m.name} 失败: ${e.message}`)
    }
  }
  if (!done) {
    failures += 1
    console.log(`FAIL ${t.out}  所有镜像均失败`)
  }
}

console.log(failures === 0 ? '== ALL UPDATED ==' : `== ${failures} FAILED ==`)
process.exit(failures === 0 ? 0 : 1)
