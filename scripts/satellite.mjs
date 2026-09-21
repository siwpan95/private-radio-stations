// 卫星影像 → 离线渲染 mp4（供 apps/video 以点播源转播）。
//
// 背景（详见 docs/SATELLITE_SOURCES.md，结论均来自本机实测）：
//   - NASA GIBS 提供的是 WMTS 静态瓦片，**不存在可直接拉取的卫星视频流**，
//     故必须先把瓦片拼成整幅地球图，再用 ffmpeg 离线渲染成视频。
//   - 本机**无可用硬件编码**（nvenc/qsv/amf 实测全失败），软件编码无法实时；
//     因此采用「离线渲染 → 成品 mp4 → 由现有 station/streamer 以 -c copy 播放」，
//     这也是卫星影像「每天/每 10 分钟」更新节奏的自然形态。
//
// 用法：
//   node scripts/satellite.mjs                     # 默认源、默认日期（today-1）、默认输出
//   node scripts/satellite.mjs --date 2026-09-19   # 指定日期
//   node scripts/satellite.mjs --zoom 2            # 指定缩放级别（越小越省流量）
//   node scripts/satellite.mjs --days 5            # 连续 N 天做延时动画（并产出混合图）
//   node scripts/satellite.mjs --source weld       # 换图层源（见 SOURCES）
//   node scripts/satellite.mjs --list              # 列出内置源
//   node scripts/satellite.mjs --keep-tiles        # 保留中间瓦片（默认清理）
//   node scripts/satellite.mjs --no-blend          # 跳过 lighten 混合
//   node scripts/satellite.mjs --secperframe 3     # 每帧展示秒数（默认 2）
//
// 设计约束：
//   - **仅用 Node 内置能力**（fetch / fs / child_process），无第三方依赖；
//   - 路径**自发现**：以本文件位置推导仓库根，不写死盘符或绝对路径；
//   - 抓取**串行 + 间隔**，避免对 NASA 公共服务造成压力；
//   - 全程**可诊断**：失败逐条点名原因，不吞错。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// 与 apps/video 的 ctx.config.root 保持同一语义（那里也是 apps/video）。
// 必须在此显式拼接：本脚本位于仓库根的 scripts/，默认输出要落到 apps/video/satellite，
// 否则成品会生成在仓库根，跑起来的应用在 /api/status 里永远列不出来。
const VIDEO_APP_DIR = path.join(ROOT, 'apps', 'video')

// ---- 内置数据源 ----------------------------------------------------------
// 全部为 NASA 公有领域数据，免费、免注册、免 API Key。
// 注意：**每个图层的 TileMatrixSet 可能不同**（Level9 / Level12 等），
// 因此此处只声明图层与时间格式，矩阵集由 capabilities 文档动态解析（见 resolveMatrixSet）。
const SOURCES = {
  // MODIS 每日真彩：最推荐。日更新、全球覆盖、色彩自然。
  // 注意 tile 路径层级为 {z}/{y}/{x}（row 在前），扩展名必须是 .jpeg。
  modis: {
    label: 'MODIS Terra 真彩（每日，推荐）',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    time: 'daily', // {time} = YYYY-MM-DD
    defaultZoom: 3,
    extension: 'jpeg',
  },
  viirs: {
    label: 'VIIRS NOAA-20 真彩（每日，备用）',
    layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    time: 'daily',
    defaultZoom: 3,
    extension: 'jpeg',
  },
  // Landsat WELD 月度合成：**无缝但有大片黑色空洞**（实测见文档），
  // 适合做静态底图，不适合当作每日动态影像。
  weld: {
    label: 'Landsat WELD 真彩月度合成（无缝，但有空洞）',
    layer: 'Landsat_WELD_CorrectedReflectance_TrueColor_Global_Monthly',
    time: 'monthly', // {time} = YYYY-MM-01
    defaultTime: '2001-11-01',
    defaultZoom: 3,
    extension: 'jpeg',
  },
}

const CAPS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml'
const TILE_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
const TILE_PX = 256

// ---- 参数解析 ------------------------------------------------------------
const argv = process.argv.slice(2)
function flag(name) {
  return argv.includes('--' + name)
}
function opt(name, fallback = null) {
  const i = argv.indexOf('--' + name)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}

if (flag('list')) {
  console.log('内置卫星源：\n')
  for (const [k, s] of Object.entries(SOURCES)) {
    console.log(`  ${k.padEnd(8)} ${s.label}`)
    console.log(`           layer=${s.layer}`)
  }
  console.log('\n用法：node scripts/satellite.mjs --source <名字> [--date YYYY-MM-DD] [--zoom N] [--days N]')
  process.exit(0)
}

const sourceName = opt('source', 'modis')
const source = SOURCES[sourceName]
if (!source) {
  console.error(`[satellite] 未知源「${sourceName}」。可用：${Object.keys(SOURCES).join(' / ')}`)
  console.error('           用 --list 查看详情。')
  process.exit(2)
}

// 默认日期 = 今天 - 1。
// 关键（实测）：GIBS 当天数据尚未发布，直接取当天会得到**全白瓦片**。
const daysBack = Number(opt('days', '0')) || 0
const explicitDate = opt('date', null)

function shiftDate(base, deltaDays) {
  const d = new Date(base.getTime() + deltaDays * 86400000)
  return d.toISOString().slice(0, 10)
}

function toGibsTime(iso, kind) {
  // GIBS 的月度合成要求 YYYY-MM-01；每日为 YYYY-MM-DD
  return kind === 'monthly' ? iso.slice(0, 7) + '-01' : iso
}

const zoom = Number(opt('zoom', String(source.defaultZoom)))
if (!Number.isInteger(zoom) || zoom < 0 || zoom > 9) {
  console.error(`[satellite] --zoom 必须是 0..9 的整数（GIBS GoogleMapsCompatible 最高 9）。收到：${opt('zoom')}`)
  process.exit(2)
}

// 输出：默认落在 apps/video/satellite 下，与 apps/video 的 ctx.config.root 约定一致，
// 供 web 面板的 satelliteStatus() 发现并转播。
const outDir = opt('out', path.join(VIDEO_APP_DIR, 'satellite'))
const outFile = opt('outfile', path.join(outDir, 'satellite.mp4'))

// ffmpeg：自发现（仓库根 bin/ 优先，其次 PATH）
function resolveFfmpeg() {
  const candidates = [
    path.join(ROOT, 'bin', 'ffmpeg.exe'),
    path.join(ROOT, 'bin', 'ffmpeg'),
    path.join(ROOT, 'ffmpeg', 'ffmpeg.exe'),
    path.join(ROOT, 'apps', 'video', 'ffmpeg', 'ffmpeg.exe'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // 退回 PATH
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  if (probe.status === 0) return 'ffmpeg'
  return null
}

// ---- 解析 capabilities：动态取得该图层的 TileMatrixSet 与可用格式 --------
// 不做这一步的后果：把 Level9 写死，遇到 Level12 的图层会全线 HTTP 400
// （实测 Landsat WELD 即为此情形）。
async function resolveMatrixSet(layer) {
  const cacheFile = path.join(ROOT, '.satellite-caps.xml')
  let xml = null
  const CACHE_MAX_AGE_MS = 7 * 86400000 // capabilities 变动不频繁，缓存 7 天
  try {
    const st = fs.statSync(cacheFile)
    if (Date.now() - st.mtimeMs < CACHE_MAX_AGE_MS) {
      xml = fs.readFileSync(cacheFile, 'utf8')
    }
  } catch {
    /* 无缓存，走网络 */
  }
  if (!xml) {
    process.stdout.write('  拉取 WMTS capabilities… ')
    const res = await fetch(CAPS_URL, { headers: { 'User-Agent': 'private-radio-stations/satellite' } })
    if (!res.ok) throw new Error(`capabilities 请求失败 HTTP ${res.status}`)
    xml = await res.text()
    console.log(`ok (${(xml.length / 1048576).toFixed(2)} MB)`)
    try {
      fs.writeFileSync(cacheFile, xml)
    } catch {
      /* 缓存写失败不影响主流程 */
    }
  }

  // 按 <Layer> 切块，找目标图层，取其 TileMatrixSet
  const blocks = xml.split('<Layer>')
  for (const b of blocks) {
    const idm = b.match(/<ows:Identifier>([^<]+)<\/ows:Identifier>/)
    if (!idm || idm[1] !== layer) continue
    const tms = b.match(/<TileMatrixSet>([^<]+)<\/TileMatrixSet>/)
    if (!tms) break
    return tms[1]
  }
  throw new Error(
    `capabilities 里找不到图层「${layer}」的 TileMatrixSet。` +
      `可能是图层名拼错或该图层已下线——用 --list 核对内置源。`
  )
}

// ---- 瓦片坐标换算（Web Mercator / EPSG:3857）----------------------------
// 语义（与 OSM slippy map 参考实现一致）：
//   degToTile  → 经纬度所在瓦片的整数索引 (x=列, y=行)
//   tileToLonLat → 该瓦片**左上角**的经纬度（非中心；z0 即墨卡托西北角）
// 导出给单测使用：纯函数，无副作用。
export function tileToLonLat(x, y, z) {
  const n = 2 ** z
  const lon = (x / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lon, lat: (latRad * 180) / Math.PI }
}

export function degToTile(lat, lon, z) {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)
  return { x, y }
}

export function tileUrl(base, layer, time, matrixSet, z, y, x, ext) {
  // 注意顺序：{TileMatrix}/{TileRow}/{TileCol} = z/y/x（row 在前）
  return `${base}/${layer}/default/${time}/${matrixSet}/${z}/${y}/${x}.${ext}`
}

// ---- 主流程 --------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchTile(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'private-radio-stations/satellite' } })
    if (!res.ok) {
      // 空白瓦片服务端也可能返回 404；交给上层按内容判定
      return { ok: false, status: res.status, buf: null }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, status: res.status, buf }
  } catch (e) {
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1))
      return fetchTile(url, attempt + 1)
    }
    return { ok: false, status: 0, buf: null, error: e.message }
  }
}

async function fetchMosaic(dateIso, matrixSet, tilesDir) {
  const n = 2 ** zoom
  const total = n * n
  const gibsTime = toGibsTime(dateIso, source.time)
  console.log(`  日期 ${gibsTime}  zoom=${zoom}  瓦片 ${n}x${n}=${total}`)

  let ok = 0
  let blank = 0
  let fail = 0
  const failed = []
  const t0 = Date.now()

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const url = tileUrl(TILE_BASE, source.layer, gibsTime, matrixSet, zoom, y, x, source.extension)
      const r = await fetchTile(url)
      if (r.ok) {
        fs.writeFileSync(path.join(tilesDir, `${y}_${x}.${source.extension}`), r.buf)
        ok++
        // 实测空白瓦片恰为 1665 字节；据此提示（不阻断，仍写入以保持网格完整）
        if (r.buf.length <= 2000) blank++
      } else {
        fail++
        failed.push(`${y}_${x} (HTTP ${r.status}${r.error ? ' ' + r.error : ''})`)
        // 失败格用空白占位，避免网格错位
        fs.writeFileSync(path.join(tilesDir, `${y}_${x}.${source.extension}`), Buffer.alloc(0))
      }
      await sleep(120) // 礼貌抓取，避免给 NASA 服务施压
    }
    process.stdout.write(`\r  进度 ${((y + 1) / n * 100).toFixed(0)}%  下载 ${ok}  空白 ${blank}  失败 ${fail}   `)
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\r  抓取完成：${ok}/${total} 成功，${blank} 空白，${fail} 失败，用时 ${dt}s      `)

  if (fail) {
    console.log('  失败明细（前 10 条）：')
    for (const f of failed.slice(0, 10)) console.log('    ' + f)
  }
  if (ok === 0) throw new Error('所有瓦片均抓取失败——请检查网络（见 docs/NETWORK.md）。')
  if (blank === total) {
    throw new Error(
      '全部为空白瓦片：该日期很可能尚未发布。' +
        'GIBS 当天数据不可用，请用 --date 指定更早的日期（默认已是 today-1）。'
    )
  }
  return { ok, blank, fail }
}

function mosaicToPng(ffmpeg, tilesDir, pngPath) {
  const n = 2 ** zoom
  const files = []
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      files.push(path.join(tilesDir, `${y}_${x}.${source.extension}`))
    }
  }
  const args = [ffmpeg, '-hide_banner', '-y']
  for (const f of files) args.push('-i', f)
  const layout = files
    .map((_, i) => `${(i % n) * TILE_PX}_${Math.floor(i / n) * TILE_PX}`)
    .join('|')
  const labels = files.map((_, i) => `[${i}:v]`).join('')
  args.push(
    '-filter_complex',
    `${labels}xstack=inputs=${files.length}:layout=${layout}[o]`,
    '-map',
    '[o]',
    '-frames:v',
    '1',
    pngPath
  )
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error('瓦片拼接失败：' + (r.stderr || '').slice(-600))
  }
  return pngPath
}

// 多日 lighten 混合：MODIS 是极轨卫星，单日影像存在**斜向条带缝隙**
// （相邻轨道之间未扫描到的楔形空区，在拼图上表现为黑带）。
// 用 blend=lighten 逐日叠加，取较亮像素——缺失处为黑，会被邻近日的真实
// 影像取代，从而显著减轻缝隙（实测 2 日即可见明显改善，5 日更好）。
function blendPngs(ffmpeg, pngs, outPath) {
  if (pngs.length < 2) {
    fs.copyFileSync(pngs[0], outPath)
    return outPath
  }
  const args = [ffmpeg, '-hide_banner', '-y']
  for (const p of pngs) args.push('-i', p)

  const chain = []
  let prev = '[0:v]'
  for (let i = 1; i < pngs.length; i++) {
    const isLast = i === pngs.length - 1
    const label = isLast ? '[blend]' : `[b${i}]`
    chain.push(`${prev}[${i}:v]blend=all_mode=lighten${label}`)
    prev = `[b${i}]`
  }
  args.push('-filter_complex', chain.join(';'), '-map', '[blend]', '-frames:v', '1', outPath)
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error('多日混合失败：' + (r.stderr || '').slice(-600))
  }
  return outPath
}

function renderVideo(ffmpeg, frames, outPath) {
  // 逐帧 PNG → H.264 mp4。
  //
  // 注意（实测）：**本机 ffmpeg 构建不支持 `-pattern_type glob`**
  // （报 "globbing is not supported by this libavformat build"），
  // 因此必须用编号序列 `frame_%04d.png` 而非通配符。
  const secPerFrame = Number(opt('secperframe', '2')) || 2
  const fps = 1 / secPerFrame

  // 帧已按 frame_%04d.png 命名并按时间正序生成，可直接序列读入
  const seqPattern = path.join(path.dirname(frames[0]), 'frame_%04d.png')
  const args = [
    ffmpeg, '-hide_banner', '-y',
    '-framerate', String(fps),
    '-i', seqPattern,
    // 统一到偶数宽高（H.264 yuv420p 要求）
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath,
  ]
  console.log(`  渲染 mp4（${secPerFrame}s/帧，共 ${frames.length} 帧）…`)
  const t0 = Date.now()
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error('ffmpeg 渲染失败：' + (r.stderr || '').slice(-800))
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  渲染完成，用时 ${dt}s`)
}

async function main() {
  console.log(`[satellite] 源：${source.label}`)
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    console.error('[satellite] 找不到 ffmpeg。期望位置：<仓库根>/bin/ffmpeg.exe，或 PATH 中可用。')
    process.exit(1)
  }
  console.log(`[satellite] ffmpeg：${ffmpeg}`)

  const matrixSet = await resolveMatrixSet(source.layer)
  console.log(`[satellite] TileMatrixSet：${matrixSet}`)

  fs.mkdirSync(outDir, { recursive: true })
  const workDir = path.join(outDir, '.work')
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })
  const keepTiles = flag('keep-tiles')

  // 日期序列：--days N 表示以 --date（或 today-1）为起点，向过去取 N 天
  const baseDate = explicitDate
    ? new Date(explicitDate + 'T00:00:00Z')
    : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
  const startOffset = explicitDate ? 0 : -1 // 未显式指定时，默认 today-1
  const count = Math.max(1, daysBack + 1)

  const dates = []
  for (let i = 0; i < count; i++) {
    dates.push(shiftDate(baseDate, startOffset - i))
  }
  // 按时间正序（旧 → 新），延时动画方向自然
  dates.reverse()

  if (source.time === 'monthly' && !explicitDate) {
    dates.length = 0
    dates.push(source.defaultTime)
    console.log(`[satellite] 月度合成源，使用默认时间 ${source.defaultTime}（可用 --date 覆盖）`)
  }

  const frames = []
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]
    console.log(`\n[${i + 1}/${dates.length}] ${d}`)
    const tilesDir = path.join(workDir, `tiles_${d}`)
    fs.mkdirSync(tilesDir, { recursive: true })
    await fetchMosaic(d, matrixSet, tilesDir)
    // 编号命名（frame_%04d.png）：本机 ffmpeg 不支持 glob，必须用序列读入
    const png = path.join(workDir, `frame_${String(i).padStart(4, '0')}.png`)
    mosaicToPng(ffmpeg, tilesDir, png)
    console.log(`  拼图 → ${path.relative(ROOT, png)}  (${(fs.statSync(png).size / 1048576).toFixed(2)} MB)`)
    if (!keepTiles) fs.rmSync(tilesDir, { recursive: true, force: true })
    frames.push(png)
  }

  // 多日时额外产出一张 lighten 混合图（减轻条带缝隙），供做「最佳单帧」使用
  let blendPath = null
  if (frames.length >= 2 && !flag('no-blend')) {
    blendPath = path.join(outDir, 'satellite-blend.png')
    console.log('\n多日 lighten 混合（减轻 MODIS 条带缝隙）…')
    blendPngs(ffmpeg, frames, blendPath)
    console.log(`  混合图 → ${path.relative(ROOT, blendPath)}  (${(fs.statSync(blendPath).size / 1048576).toFixed(2)} MB)`)
  }

  // 单帧时直接输出该帧为静态图；多帧时渲染延时视频
  if (frames.length === 1) {
    const still = path.join(outDir, 'satellite.png')
    fs.copyFileSync(frames[0], still)
    console.log(`\n[satellite] 单帧产出：${still}`)
    console.log('（如需视频，用 --days N 取多日生成延时动画）')
    return
  }

  renderVideo(ffmpeg, frames, outFile)
  const size = (fs.statSync(outFile).size / 1048576).toFixed(2)
  console.log(`\n[satellite] 产出：${outFile}  (${size} MB)`)
  if (blendPath) console.log(`           混合图：${blendPath}`)

  // 生成/更新 presets 片段，方便直接转播
  const fileUrl = 'file:///' + outFile.replace(/\\/g, '/')
  console.log('\n转播方式（二选一）：')
  console.log('  A. 面板「手动 URL」填：' + fileUrl)
  console.log('  B. 或放进 apps/video/presets.json（注意 live:false，否则播完会被当成断流重试）：')
  console.log(
    '     ' +
      JSON.stringify({
        name: `卫星影像 ${dates[dates.length - 1]}`,
        url: fileUrl,
        desc: `${source.label} · 离线渲染`,
        icon: '🛰️',
        live: false,
      })
  )

  if (!keepTiles) {
    fs.rmSync(path.join(workDir, 'tiles_*'), { recursive: true, force: true })
  } else {
    console.log(`\n[satellite] 中间帧保留在：${path.relative(ROOT, workDir)}`)
  }
}

// 仅在作为主脚本运行时执行 main（被 import 做单测时不执行）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((e) => {
    console.error('\n[satellite] 失败：' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}
