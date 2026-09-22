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
import { spawn, spawnSync } from 'node:child_process'

// 单次生成的总时长上限（分钟）。可用环境变量 SATELLITE_TIMEOUT_MIN 覆盖。
// 为什么需要看门狗（实测教训）：satellite.mjs 曾因 Windows 上 fs.rmSync 递归删除
// 偶发挂起、以及无超时的 fetch 卡在 GIBS 上，导致一次「每日任务」挂了 4.5 小时
// 既不产出也不退出——进程锁因此长期占用，cordis 调度与 WorkBuddy 自动化双双失效。
// 有了看门狗，最坏情况是有界的：超时即杀进程树、释放锁、以 124 退出并留日志。
const DEFAULT_TIMEOUT_MIN = 25

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

// Windows 上 child.kill() 只杀直接子进程，ffmpeg 等孙进程会残留，必须用 taskkill /T。
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  } catch {
    /* 尽力而为 */
  }
}

// 带看门狗的子进程执行：超时（默认 25 分钟）则杀掉整棵进程树并返回 status=124。
export function spawnWithWatchdog(argv, stdioFd, timeoutMinutes = DEFAULT_TIMEOUT_MIN) {
  const ms = Math.max(1, Number(timeoutMinutes) || DEFAULT_TIMEOUT_MIN) * 60 * 1000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, argv, {
        cwd: ROOT,
        stdio: ['ignore', stdioFd, stdioFd],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ status: 1, error: e.message, timedOut: false })
      return
    }
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish({ status: 124, timedOut: true, minutes: Math.round(ms / 60000) })
    }, ms)
    child.on('exit', (code, signal) => finish({ status: code, signal, timedOut: false }))
    child.on('error', (e) => finish({ status: 1, error: e.message, timedOut: false }))
  })
}

// 进程是否还活着（Windows 上 process.kill(pid, 0) 对存在但无权访问的进程会抛 EPERM，
// 那也算"活着"）。用于判断 .run.lock 里的 PID 是否仍占据生成任务。
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

async function main() {
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

  // 进程锁：避免 cordis 服务与 WorkBuddy 自动化并发；锁内记录 {pid, at}。
  // 只要持锁进程还活着就跳过；进程已死（被 kill / 崩溃 / 断电残留）则视为陈旧锁立即接管。
  //   实测教训：只用「锁文件年龄 <6h」判断时，一次被中断的生成会让接下来 6 小时内
  //   的所有触发全部静默跳过（包括面板「立即生成一次」和 cordis 调度）。
  if (fs.existsSync(lockPath)) {
    let held = null
    try {
      held = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    } catch {
      held = null // 老格式（只有时间戳）或内容损坏，退回按年龄判断
    }
    const age = Date.now() - fs.statSync(lockPath).mtimeMs
    const stillRunning = held && Number.isInteger(held.pid)
      ? pidAlive(held.pid)
      : age < 6 * 3600 * 1000
    if (stillRunning) {
      console.log(
        `[satellite-daily] 已有进行中的运行（PID ${held && held.pid ? held.pid : '未知'}），跳过。`
      )
      process.exit(0)
    }
    fs.rmSync(lockPath, { force: true }) // 持锁进程已不在：清理后继续
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }))

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
  const timeoutMin = Number(process.env.SATELLITE_TIMEOUT_MIN) || DEFAULT_TIMEOUT_MIN
  const r = await spawnWithWatchdog(argv, logFd, timeoutMin)
  fs.closeSync(logFd)

  if (r.timedOut) {
    fs.rmSync(lockPath, { force: true })
    console.error(
      `[satellite-daily] 超过 ${r.minutes} 分钟未完成，已终止子进程并释放锁。` +
        `详见 ${path.relative(ROOT, logPath)}（常见原因：网络挂起 / 瓦片清理被占用）。`
    )
    process.exit(124)
  }

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
if (isMain) {
  main().catch((e) => {
    console.error('[satellite-daily] 未捕获异常：' + ((e && e.stack) || e))
    process.exit(1)
  })
}
