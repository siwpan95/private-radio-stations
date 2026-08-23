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
for (const dir of ['packages/core/src', 'apps/video/src', 'apps/video/public', 'apps/video/scripts', 'apps/video/test', 'apps/audio/src', 'apps/audio/public', 'apps/audio/scripts', 'apps/audio/test', 'apps/audio/extension']) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) continue
  for (const p of collectJs(abs)) {
    const r = run(NODE, ['--check', p])
    if (r.status !== 0) fail('syntax: ' + path.relative(ROOT, p) + '\n' + r.stderr.slice(0, 600))
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
for (const pj of ['package.json', 'packages/core/package.json', 'apps/video/package.json', 'apps/audio/package.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, pj), 'utf8'))
    console.log('   ' + pj + ' ok')
  } catch (e) {
    fail(pj + ' invalid: ' + e.message)
  }
}

console.log('== check: git whitespace (staged) ==')
if (fs.existsSync(path.join(ROOT, '.git'))) {
  const r = run('git', ['diff', '--cached', '--check'])
  if (r.status !== 0) fail('staged whitespace:\n' + r.stdout)
  else console.log('   whitespace ok')
}

if (!fast) {
  console.log('== check: unit tests ==')
  const suites = ['packages/core/test/loader.test.mjs', 'apps/video/test/station.test.mjs', 'apps/video/test/channels.test.mjs', 'apps/audio/test/station.test.mjs', 'apps/audio/test/presets.test.mjs']
  const r = run(NODE, ['--test', ...suites])
  if (r.status !== 0) fail('unit tests:\n' + (r.stdout || '') + (r.stderr || ''))
  else console.log('   tests ok')
}

if (failures.length) {
  console.error('\ncheck FAILED: ' + failures.length)
  process.exit(1)
}
console.log('\ncheck PASSED')
