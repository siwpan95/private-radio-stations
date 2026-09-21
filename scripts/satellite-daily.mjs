// 每日卫星影像调度编排器（供 apps/video 的 satelliteScheduler 服务 与 WorkBuddy 自动化共用）。
//
// 相对 scripts/satellite.mjs 的「单一渲染职责」，本文件只做「编排」：
//   1. 读取 apps/video/cordis.yml 里 config 插件下的 satellite 配置段
//      （source/zoom/days/dir/auto/hour/keep），纯文本切片解析，规避 !!js 标签，无第三方依赖；
//   2. 以日期戳命名产出 satellite-YYYY-MM-DD.mp4，并保留最近 keep 份（裁剪旧 mp4 与日志）；
//   3. 成功后把最新一份复制为 satellite.mp4 —— 面板/预设的稳定入口（旧版 preset 仍可播）；
//   4. 进程锁（.run.lock）防止 cordis 服务与 WorkBuddy 自动化并发或上次未完成时重复触发；
//   5. 日志落盘 apps/video/satellite/.daily-YYYY-MM-DD.log，失败时不覆盖上一份好片。
//
// 用法：
//   node scripts/satellite-daily.mjs          # 按 cordis.yml 配置跑一次
//   node scripts/satellite-daily.mjs --dry   # 仅打印将要执行的命令，不真正抓取/渲染
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const VIDEO_APP_DIR = path.join(ROOT, 'apps', 'video')
const CORDIS_YML = path.join(VIDEO_APP_DIR, 'cordis.yml')
const SAT_SCRIPT = path.join(ROOT, 'scripts', 'satellite.mjs')

export function todayIso(d = new Date()) {
  // 本地日期（非 UTC）：卫星影像按本地「今天」语义生成，避免跨时区错位。
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 纯文本切片解析 cordis.yml 里 config 插件下的 satellite 段。
// 不引入 yaml 依赖、也不触碰 !!js 标签（satellite 段全是普通标量）。
// 返回带默认值的完整配置；yml 缺失或段缺失时回退默认值。
export function parseSatelliteConfig(ymlPath = CORDIS_YML) {
  const defaults = {
    enabled: true,
    dir: 'satellite',
    source: 'modis',
    zoom: 3,
    days: 5,
    auto: true,
    hour: 3,
    keep: 7,
  }
  let text
  try {
    text = fs.readFileSync(ymlPath, 'utf8')
  } catch {
    return { ...defaults }
  }
  const lines = text.split(/\r?\n/)
  const raw = {}
  let started = false
  for (const line of lines) {
    // 进入 satellite: 段（config 插件 config 映射下，缩进 6 空格）
    if (/^ {6}satellite:\s*$/.test(line)) {
      started = true
      continue
    }
    if (!started) continue
    // 遇到下一个同级键（6 空格）或下一个插件（- id:）即结束
    if (/^ {6}\w/.test(line) || /^  - id:/.test(line)) break
    const m = line.match(/^ {8}(\w+):\s*(.*)$/)
    if (m) {
      let v = m[2].trim()
      v = v.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '') // 去行内注释与引号
      raw[m[1]] = v
    }
  }
  const out = { ...defaults }
  if ('enabled' in raw) out.enabled = raw.enabled !== 'false'
  if ('auto' in raw) out.auto = raw.auto !== 'false'
  if (raw.dir) out.dir = raw.dir
  if (raw.source) out.source = raw.source
  if (raw.zoom !== undefined) {
    const n = Number(raw.zoom)
    if (Number.isFinite(n)) out.zoom = n
  }
  if (raw.days !== undefined) {
    const n = Number(raw.days)
    if (Number.isFinite(n)) out.days = n
  }
  if (raw.hour !== undefined) {
    const n = Number(raw.hour)
    if (Number.isFinite(n)) out.hour = Math.min(23, Math.max(0, Math.trunc(n)))
  }
  if (raw.keep !== undefined) {
    const n = Number(raw.keep)
    if (Number.isFinite(n)) out.keep = Math.min(90, Math.max(1, Math.trunc(n)))
  }
  return out
}

export function datedOutfile(dir, date = todayIso()) {
  return path.join(dir, `satellite-${date}.mp4`)
}

// 保留最近 keep 份 satellite-YYYY-MM-DD.mp4 与 .daily-YYYY-MM-DD.log（按文件名日期倒序裁剪）。
// 目录不存在或读取失败均安全返回 []（不抛错，避免影响每日流程）。
export function pruneOld(dir, keep = 7) {
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const mp4s = entries.filter((f) => /^satellite-\d{4}-\d{2}-\d{2}\.mp4$/.test(f)).sort()
  const logs = entries.filter((f) => /^\.daily-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
  const removed = []
  for (const f of mp4s.slice(0, Math.max(0, mp4s.length - keep))) {
    fs.rmSync(path.join(dir, f), { force: true })
    removed.push(f)
  }
  for (const f of logs.slice(0, Math.max(0, logs.length - keep))) {
    fs.rmSync(path.join(dir, f), { force: true })
  }
  return removed
}

function main() {
  const cfg = parseSatelliteConfig()
  if (cfg.enabled === false || cfg.auto === false) {
    console.log('[satellite-daily] 跳过：satellite.enabled/auto=false')
    process.exit(0)
  }
  const outDir = path.resolve(VIDEO_APP_DIR, cfg.dir)
  fs.mkdirSync(outDir, { recursive: true })
  const date = todayIso()
  const outFile = datedOutfile(outDir, date)
  const logPath = path.join(outDir, `.daily-${date}.log`)
  const lockPath = path.join(outDir, '.run.lock')

  // 进程锁：避免 cordis 服务与 WorkBuddy 自动化并发；锁 <6h 视为进行中，跳过。
  if (fs.existsSync(lockPath)) {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs
    if (age < 6 * 3600 * 1000) {
      console.log('[satellite-daily] 已有进行中的运行（锁 <6h），跳过。')
      process.exit(0)
    }
    fs.rmSync(lockPath, { force: true }) // 锁过旧：上次可能崩溃残留，清理后继续
  }
  fs.writeFileSync(lockPath, String(Date.now()))

  const argv = [
    SAT_SCRIPT,
    '--source', String(cfg.source),
    '--zoom', String(cfg.zoom),
    '--days', String(cfg.days),
    '--out', outDir,
    '--outfile', outFile,
  ]

  if (process.argv.includes('--dry')) {
    fs.rmSync(lockPath, { force: true })
    console.log('[satellite-daily][dry] node ' + argv.join(' '))
    console.log('[satellite-daily][dry] outDir=' + outDir + ' keep=' + cfg.keep)
    process.exit(0)
  }

  console.log(`[satellite-daily] 调用：${path.relative(ROOT, SAT_SCRIPT)} source=${cfg.source} zoom=${cfg.zoom} days=${cfg.days}`)
  console.log(`[satellite-daily] 产出：${path.relative(ROOT, outFile)}`)

  const logFd = fs.openSync(logPath, 'w')
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', logFd, logFd] })
  fs.closeSync(logFd)

  if (r.status !== 0) {
    fs.rmSync(lockPath, { force: true })
    console.error(`[satellite-daily] satellite.mjs 失败（exit=${r.status}）。详见 ${path.relative(ROOT, logPath)}`)
    process.exit(typeof r.status === 'number' ? r.status : 1)
  }

  // 成功：复制为最新 satellite.mp4（面板/预设的稳定入口），再裁剪历史
  const latest = path.join(outDir, 'satellite.mp4')
  fs.copyFileSync(outFile, latest)
  const removed = pruneOld(outDir, cfg.keep)
  fs.rmSync(lockPath, { force: true })
  console.log(`[satellite-daily] 完成。最新=${path.relative(ROOT, latest)}，已裁剪旧档：${removed.join(', ') || '无'}`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
