// harness.mjs — 编排 harness 入口：黄金值用例 + 共识/分歧 + 退出码绑定。
// 对齐 E:\lab chess-cordis/src/harness.mjs（GOLDEN_POSITIONS / analyzeDivergence / formatReport）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPort } from './port.mjs'
import { register, disposeAll, runCmd, analyzeDivergence, snapshot } from './registry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness', 'manifest.json'), 'utf8'))
const resolve = (s) => (s || '')
  .replaceAll('{root}', ROOT)
  .replaceAll('{node}', MANIFEST.runtime?.node || 'node')
  .replaceAll('{python}', MANIFEST.runtime?.python || 'python')

// 挂载组件（组合即数据：enabled:false = 运行时下架，对齐 cordis.yml 语义）
for (const c of MANIFEST.components) {
  if (c.enabled === false) continue
  if (c.kind === 'subprocess') {
    mountPort({ id: c.id, kind: c.kind, cmd: resolve(c.cmd), args: (c.args || []).map(resolve), cwd: resolve(c.cwd || '{root}'), timeout: c.timeout ?? 15000 })
  } else if (c.kind === 'probe') {
    register(c.id, {
      kind: 'probe', alive: () => true, ready: () => true,
      call: async () => {
        const r = await fetch(c.target, { signal: AbortSignal.timeout(c.timeout ?? 5000) })
        const body = await r.text()
        if (r.status !== 200) throw new Error('status ' + r.status)
        if (c.marker && !body.includes(c.marker)) throw new Error('marker missing: ' + c.marker)
        return r.status
      },
    })
  }
}

// 黄金值用例（单一真相源 = spec.md；expected:null = informational 用例；
// expectDiverged:[] = informational 用例的预期分歧名单，超出预期同样失败）
const CASES = [
  { name: 'full-gate', cmd: 'check', participants: ['radio-gate'], expected: 0, expectConsensus: true },
  { name: 'fast-gate', cmd: 'fast', participants: ['radio-gate'], expected: 0, expectConsensus: true },
]

const report = []
let failures = 0
const events = []
for (const c of CASES) {
  const all = await runCmd(c.cmd, c.payload || {})
  const sub = all.filter((r) => c.participants.includes(r.id))
  const errors = sub.filter((r) => !r.ok)
  const { consensus, diverged } = analyzeDivergence(sub)
  const match = c.expected === null ? true : (consensus !== null && JSON.stringify(consensus) === JSON.stringify(c.expected))
  if (c.expectConsensus && (diverged.length || errors.length || !match)) failures++
  // E4 eval-invariant：informational 用例声明预期分歧名单，超出预期 = 真失败
  if (!c.expectConsensus && Array.isArray(c.expectDiverged)) {
    const got = [...diverged].sort().join(',')
    const want = [...c.expectDiverged].sort().join(',')
    if (got !== want) failures++
  }
  if (diverged.length || errors.length || (c.expected !== null && !match)) {
    events.push({ type: 'divergence', case: c.name, consensus, expected: c.expected, expectDiverged: c.expectDiverged ?? null, diverged, errors: errors.map((r) => r.id + ':' + r.error) })
  }
  report.push({ c, sub, consensus, diverged, errors, match })
}

const lines = []
lines.push('=== ' + "private-radio-stations" + ' harness: golden cases ===')
lines.push('components: ' + snapshot().map((s) => s.id + (s.alive ? '' : '(dead)')).join(' '))
for (const { c, sub, consensus, diverged, errors, match } of report) {
  const status = match && !diverged.length && !errors.length ? 'PASS' : 'FAIL'
  const vals = sub.map((r) => r.id + '=' + (r.ok ? JSON.stringify(r.value) : 'ERR(' + r.error + ')') + '/' + r.ms + 'ms').join('  ')
  lines.push('[' + status + '] ' + c.name + '  expected=' + JSON.stringify(c.expected) + '  consensus=' + JSON.stringify(consensus) + '  ' + vals)
  if (diverged.length) lines.push('        diverged: ' + diverged.join(', '))
  if (errors.length) lines.push('        errors: ' + errors.map((r) => r.id + ': ' + r.error).join(' | '))
}

// E5 分歧事件订阅链路：异常事件以 JSON-lines 追加到 sink，供 CI/上层订阅与告警
if (events.length) {
  const sink = process.env.DIVERGENCE_EVENT_FILE || path.join(ROOT, 'data', 'divergence-events.jsonl')
  fs.mkdirSync(path.dirname(sink), { recursive: true })
  const stream = fs.createWriteStream(sink, { flags: 'a' })
  for (const e of events) {
    stream.write(JSON.stringify({ ts: new Date().toISOString(), ...e, components: snapshot().map((s) => ({ id: s.id, alive: s.alive })) }) + '\n')
  }
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())))
  lines.push('divergence-events: ' + events.length + ' appended -> ' + sink)
}
lines.push(failures === 0 ? 'OVERALL: ALL GOLDEN VALUES MATCH' : 'OVERALL: DIVERGENCE DETECTED (' + failures + ')')
console.log(lines.join('\n'))

// 退出码绑定（E6）：全绿 = exit 0；任何分歧/报错 = exit 1
await disposeAll()
process.exit(failures === 0 ? 0 : 1)
