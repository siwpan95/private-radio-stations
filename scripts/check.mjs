// monorepo 质量门禁：全仓语法检查 + yml/manifest 校验 + 单测。
// pre-commit 钩子跑 `node scripts/check.mjs --fast`；pre-push 跑全量（不含冒烟，
// 冒烟需两服务在跑，用 `npm run smoke:video` / `npm run smoke:radio` 手动执行）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const NODE = process.env.NODE_EXE || 'node'
const fast = process.argv.includes('--fast')

const failures = []
function fail(msg) {
  failures.push(msg)
  console.error('  x ' + msg)
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
}

// 定位可用的 git 可执行文件。
// 本机可能没有系统 Git（PATH 中无 git），此时 spawnSync('git', …) 会以
// status=null + error.code='ENOENT' 返回；若按 status!==0 判定会误报失败，
// 且 stdout 为 undefined 会打印出无意义的 "undefined"。
// 支持通过 GIT_EXE 环境变量显式指定（如便携版 Git），否则回退 PATH 查找。
function resolveGit() {
  const candidates = [process.env.GIT_EXE, 'git'].filter(Boolean)
  for (const exe of candidates) {
    const r = spawnSync(exe, ['--version'], { cwd: ROOT, encoding: 'utf8' })
    if (r.status === 0) return { exe, ok: true }
    if (r.error && r.error.code !== 'ENOENT') {
      // 可执行但报错：仍视为可用，交由具体命令暴露原因
      return { exe, ok: true }
    }
  }
  return { exe: null, ok: false }
}
function collectJs(dir) {
  const out = []
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) {
      if (['node_modules', 'data', 'recordings', 'hls', 'live'].includes(f)) continue
      out.push(...collectJs(p))
    } else if (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')) {
      out.push(p)
    }
  }
  return out
}

console.log('== check: syntax ==')
for (const dir of ['packages/core/src', 'apps/portal/src', 'apps/portal/public', 'apps/video/src', 'apps/video/public', 'apps/video/scripts', 'apps/video/test', 'apps/audio/src', 'apps/audio/public', 'apps/audio/scripts', 'apps/audio/test', 'apps/audio/extension']) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) continue
  for (const p of collectJs(abs)) {
    const r = run(NODE, ['--check', p])
    if (r.status !== 0) {
      // Node 二进制本身不可用时（NODE 指向不存在的路径）spawnSync 会返回
      // status=null + stderr=undefined，直接 .slice() 会抛 TypeError 把关禁
      // 崩在半路。这里统一兜底，保证任何情况下都给出可读的失败原因。
      const why = r.status === null
        ? '(node 无法执行：' + NODE + '；' + ((r.error && r.error.code) || 'unknown') + ')'
        : (r.stderr || r.stdout || '(no output)')
      fail('syntax: ' + path.relative(ROOT, p) + '\n' + String(why).slice(0, 600))
    }
  }
}
console.log('   syntax ok')

console.log('== check: cordis.yml ==')
const { parseCordisYml } = await import('@relay/core')
for (const yml of ['apps/video/cordis.yml', 'apps/audio/cordis.yml']) {
  try {
    const doc = parseCordisYml(fs.readFileSync(path.join(ROOT, yml), 'utf8'))
    if (!doc || typeof doc.plugins !== 'object') throw new Error('missing plugins')
    console.log('   ' + yml + ' ok (' + Object.keys(doc.plugins).length + ' plugins)')
  } catch (e) {
    fail(yml + ' invalid: ' + e.message)
  }
}

console.log('== check: package.json ==')
for (const pj of ['package.json', 'packages/core/package.json', 'apps/portal/package.json', 'apps/video/package.json', 'apps/audio/package.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, pj), 'utf8'))
    console.log('   ' + pj + ' ok')
  } catch (e) {
    fail(pj + ' invalid: ' + e.message)
  }
}

console.log('== check: git whitespace (staged) ==')
if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.log('   no git repo, skipped')
} else {
  const { exe: gitExe, ok: gitOk } = resolveGit()
  if (!gitOk) {
    // 非致命：本机未安装 git（或不在 PATH）时，无法检查暂存区空白。
    // 明确提示并跳过，而不是误报失败。
    console.log('   git not available, skipped (set GIT_EXE to enable)')
  } else {
    const r = run(gitExe, ['diff', '--cached', '--check'])
    if (r.status !== 0) {
      // stdout/stderr 可能为 null（无输出/异常），统一兜底避免打印 "undefined"
      fail('staged whitespace:\n' + (r.stdout || r.stderr || '(no output; status=' + r.status + ')'))
    } else {
      console.log('   whitespace ok')
    }
  }
}

if (!fast) {
  console.log('== check: unit tests ==')
  const suites = ['packages/core/test/loader.test.mjs', 'packages/core/test/settings.test.mjs', 'packages/core/test/hmr.test.mjs', 'apps/video/test/station.test.mjs', 'apps/video/test/station-refresh.test.mjs', 'apps/video/test/channels.test.mjs', 'apps/video/test/satellite.test.mjs', 'apps/audio/test/station.test.mjs', 'apps/audio/test/presets.test.mjs']
  const r = run(NODE, ['--test', ...suites])
  if (r.status !== 0) fail('unit tests:\n' + (r.stdout || '') + (r.stderr || ''))
  else console.log('   tests ok')
}

if (failures.length) {
  console.error('\ncheck FAILED: ' + failures.length)
  process.exit(1)
}
console.log('\ncheck PASSED')
