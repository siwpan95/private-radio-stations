// 质量门禁：语法检查 + manifest/yml 校验 +（可选）单测与冒烟。
// pre-commit 钩子跑 `node scripts/check.mjs --fast`，pre-push 跑全量。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const NODE = process.env.NODE_EXE || 'node'
const fast = process.argv.includes('--fast')
const withSmoke = process.argv.includes('--smoke')

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
    if (fs.statSync(p).isDirectory()) out.push(...collectJs(p))
    else if (f.endsWith('.js') || f.endsWith('.mjs')) out.push(p)
  }
  return out
}

console.log('== check: syntax ==')
for (const p of [...collectJs(path.join(ROOT, 'src')), ...collectJs(path.join(ROOT, 'extension'))]) {
  const r = run(NODE, ['--check', p])
  if (r.status !== 0) fail('syntax: ' + path.relative(ROOT, p) + String.fromCharCode(10) + r.stderr)
}
console.log('   syntax ok')

console.log('== check: manifest.json ==')
try {
  JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  console.log('   manifest ok')
} catch (e) {
  fail('extension/manifest.json invalid: ' + e.message)
}

console.log('== check: cordis.yml ==')
try {
  // 必须用运行时的 parseCordisYml（含 !!js 自定义标签的 schema）。
  // 旧实现是裸 yaml.load（默认 schema），会把 cordis.yml 里合法的
  // `port: !!js "Number(process.env.PORT) || 8000"` 判成 unknown tag —— 闸门与运行时不一致。
  const { parseCordisYml } = await import('@relay/core')
  const doc = parseCordisYml(fs.readFileSync(path.join(ROOT, 'cordis.yml'), 'utf8'))
  if (!doc || typeof doc.plugins !== 'object') throw new Error('missing plugins')
  console.log('   cordis.yml ok (' + Object.keys(doc.plugins).join(', ') + ')')
} catch (e) {
  fail('cordis.yml invalid: ' + e.message)
}

console.log('== check: git whitespace (staged) ==')
{
  const r = run('git', ['diff', '--cached', '--check'])
  if (r.status !== 0) fail('staged whitespace:' + String.fromCharCode(10) + r.stdout)
  else console.log('   whitespace ok')
}

if (!fast) {
  console.log('== check: unit tests ==')
  const r = run(NODE, ['--test', 'test/station.test.mjs', 'test/presets.test.mjs'], { env: { ...process.env } })
  if (r.status !== 0) fail('unit tests:' + String.fromCharCode(10) + (r.stdout || '') + (r.stderr || ''))
  else console.log('   tests ok')

  if (withSmoke) {
    console.log('== check: smoke ==')
    const s = run(NODE, ['scripts/smoke.mjs'])
    if (s.status !== 0) fail('smoke:' + String.fromCharCode(10) + (s.stdout || '') + (s.stderr || ''))
    else console.log('   smoke ok')
  }
}

if (failures.length) {
  console.error(String.fromCharCode(10) + 'check FAILED: ' + failures.length)
  process.exit(1)
}
console.log(String.fromCharCode(10) + 'check PASSED')
