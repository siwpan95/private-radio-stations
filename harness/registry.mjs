// registry.mjs — 跨组件唯一组合点（模块单例）。
// 对齐 E:\lab chess-cordis/src/registry.mjs：组件注册表 + 众数共识/分歧分析。
// 时间维回收：effects 栈 disposeAll 逆序执行（等价 Cordis Fiber effect 栈逆序串行回收）。
const engines = new Map()
const effects = []

export function register(id, api) { engines.set(id, api) }
export function list() { return [...engines.keys()] }
export function snapshot() { return [...engines.entries()].map(([id, e]) => ({ id, kind: e.kind, alive: e.alive(), ready: e.ready?.() ?? true })) }
export function addEffect(id, fn) { effects.push([id, fn]) }
export async function disposeAll() { for (const [id, fn] of effects.reverse()) { try { await fn() } catch {} } }

export async function runCmd(cmd, payload) {
  const results = []
  for (const [id, e] of engines) {
    const rec = { id, value: null, ok: false, error: null, ms: 0 }
    const t0 = Date.now()
    try { rec.value = await e.call(cmd, payload); rec.ok = true } catch (err) { rec.error = String(err?.message ?? err) }
    rec.ms = Date.now() - t0
    results.push(rec)
  }
  return results
}

export function analyzeDivergence(results) {
  const counts = new Map()
  for (const r of results) {
    if (!r.ok) continue
    const k = JSON.stringify(r.value)
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  let consensus = null, best = -1
  for (const [k, n] of counts) { if (n > best) { best = n; consensus = JSON.parse(k) } }
  const diverged = results.filter((r) => r.ok && JSON.stringify(r.value) !== JSON.stringify(consensus)).map((r) => r.id)
  return { consensus, diverged }
}
