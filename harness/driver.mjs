// driver.mjs — harness 侧适配器（引擎零胶水原则）：把仓内真实入口包装成 JSON-lines。
// cmd 集见 spec.md；本文件是仓内唯一知道 harness 协议的胶水。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.env.NODE_EXE || 'node'

function runCheck(fast) {
  const args = [path.join(ROOT, 'scripts', 'check.mjs')]
  if (fast) args.push('--fast')
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 390000 })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const CMD_SPEC = {
  // 全量质量门禁（语法 + cordis.yml + 包元数据 + 单测），黄金值 = exit 0
  check: () => {
    const r = runCheck(false)
    return { ok: r.status === 0, value: r.status, error: r.status === 0 ? null : (r.stderr || r.stdout).slice(-800) }
  },
  // 快速门禁（pre-commit 同款 --fast），黄金值 = exit 0
  fast: () => {
    const r = runCheck(true)
    return { ok: r.status === 0, value: r.status, error: r.status === 0 ? null : (r.stderr || r.stdout).slice(-800) }
  },
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let req
    try { req = JSON.parse(line) } catch { continue }
    const fn = CMD_SPEC[req.cmd]
    const resp = fn ? { id: req.id, ...fn() } : { id: req.id, ok: false, error: 'unknown cmd: ' + req.cmd }
    process.stdout.write(JSON.stringify(resp) + '\n')
  }
})
process.stdout.write(JSON.stringify({ ready: true }) + '\n')
