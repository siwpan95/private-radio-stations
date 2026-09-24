// link-player — 把 PluginPlayer 源码仓的构建产物同步进本仓挂载点
// ---------------------------------------------------------------------------
// 联动关系（2026-09-14 修复断链）：
//   · 供给方：独立仓 siwpan/pluginplayer（默认取同级仓 ../pluginplayer，可用 PP_SRC / --src 覆盖），
//     用 build.py 产出 dist/（pluginplayer.exe + FFmpeg/SDL3/MinGW DLL + plugins/）。
//   · 消费方：apps/video 的 launcher 插件（面板「快捷入口」，RPC 7921）与
//     apps/audio 的 monitor 插件（面板「本机监听」，RPC 7911）。
//   · 挂载点：external/pluginplayer/dist/（.gitignore 忽略，构建产物不入库）。
//
// 为什么要整目录：exe 依赖同目录的 DLL 与 plugins/，只拷一个 exe 起来就崩。
//
// 也可以完全不用本脚本——两个消费插件的 exe 解析自带源码仓兜底
// （见 apps/*/src/plugins/*.js 的 FALLBACK_EXE），构建完即生效。
//
// 用法：
//   node scripts/link-player.mjs                  # 源 = 同级仓 ../pluginplayer（或 PP_SRC）
//   node scripts/link-player.mjs D:\pp            # 指定源码仓根目录
//   node scripts/link-player.mjs --dry            # 只报告将同步什么，不落盘
//   node scripts/link-player.mjs --src X --dest Y # 显式指定（dest 覆盖仅用于自测）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
// --flag value 的取值集合：位置参数要排除它们，否则会把 flag 的值当源码仓路径。
const flagVals = new Set(argv.filter((a, i) => i > 0 && argv[i - 1].startsWith('--')))
const val = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.find((a) => !a.startsWith('--') && !flagVals.has(a))
// 2026-09-23 去本地化：默认源改同级仓推导（原路径已失效）；缺产物时由下方 existsSync 报错退出
const srcRepo = val('src') || positional || process.env.PP_SRC || path.resolve(ROOT, '..', 'pluginplayer')
const SRC = path.join(srcRepo, 'dist')
const DEST = path.resolve(val('dest') || path.join(ROOT, 'external', 'pluginplayer', 'dist'))

// 运行期产物不属于发布载荷：日志、自测输出、测试素材都不同步。
const SKIP = [
  /[\\/]logs([\\/]|$)/i,
  /[\\/]selftest_out[^\\/]*([\\/]|$)/i,
  /[\\/]test_assets([\\/]|$)/i,
  /[\\/]_extract([\\/]|$)/i,
]
const keep = (p) => !SKIP.some((re) => re.test(p))

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (!keep(p)) continue
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const srcExe = path.join(SRC, 'pluginplayer.exe')
if (!fs.existsSync(srcExe)) {
  console.error('[ERR] 源码仓里没有构建产物: ' + srcExe)
  console.error('      先在源码仓构建（约 46 秒）：')
  console.error('        cd /d ' + srcRepo)
  console.error('        python build.py --release')
  console.error('      前置：vendor/ 依赖（python tools\\fetch_deps.py）与 MinGW g++。')
  console.error('      源码仓也可用 --src <路径> / 位置参数 / 环境变量 PP_SRC 指定。')
  process.exit(1)
}

const files = walk(SRC)
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0)
console.log('源  : ' + SRC)
console.log('目标: ' + DEST)
console.log('载荷: %d 个文件, %s MB', files.length, (bytes / 1e6).toFixed(1))

if (dry) {
  for (const f of files) console.log('  ' + path.relative(SRC, f))
  console.log('[dry] 未落盘。去掉 --dry 执行同步。')
  process.exit(0)
}

fs.mkdirSync(DEST, { recursive: true })
fs.cpSync(SRC, DEST, { recursive: true, force: true, filter: keep })

const destExe = path.join(DEST, 'pluginplayer.exe')
if (!fs.existsSync(destExe)) {
  console.error('[ERR] 同步后仍缺 exe: ' + destExe)
  process.exit(1)
}

const destRel = path.relative(ROOT, DEST)
console.log('[OK] 已同步到 %s（整目录 %d 个顶层条目：exe 依赖同目录的 DLL 与 plugins/，勿单独取用 exe）',
  destRel && !destRel.startsWith('..') ? destRel : DEST, fs.readdirSync(DEST).length)
console.log('     生效核对：node scripts/dump-config.mjs video|audio 查看 launcher/monitor 的 exe')
