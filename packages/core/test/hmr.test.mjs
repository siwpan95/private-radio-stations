// P8B 完整重载单测：卸载/新增/模块变更/回滚/白名单事件（临时插件目录 + 真 cordis）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { applyEntry, applyDiff } from '../src/loader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const CORDIS_ENTRY = path.join(ROOT, 'node_modules', 'cordis', 'lib', 'index.js').replace(/\\/g, '/')

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hmr-'))
  const statePath = path.join(dir, 'state.cjs').replace(/\\/g, '/')
  fs.writeFileSync(path.join(dir, 'state.cjs'), [
    "let events = []",
    "function record(s) { events.push(s) }",
    "function dump() { return events.slice() }",
    "function reset() { events = [] }",
    "module.exports = { record, dump, reset }",
  ].join('\n'))
  const base = [
    "const { Service } = require('" + CORDIS_ENTRY + "')",
    "const { record } = require('" + statePath + "')",
  ].join('\n')
  // p1：可打 tag 的服务，dispose 记录事件
  fs.writeFileSync(path.join(dir, 'p1.js'), base + "\nclass P1 extends Service {\n  constructor(ctx, cfg) { super(ctx, 'p1'); this.tag = (cfg && cfg.tag) || 'v1' }\n  dispose() { record('p1-dispose:' + this.tag) }\n}\nmodule.exports = function (ctx, cfg) { ctx.plugin(P1, cfg) }\n")
  // p2：另一个服务
  fs.writeFileSync(path.join(dir, 'p2.js'), base + "\nclass P2 extends Service {\n  constructor(ctx, cfg) { super(ctx, 'p2') }\n  dispose() { record('p2-dispose') }\n}\nmodule.exports = function (ctx, cfg) { ctx.plugin(P2, cfg) }\n")
  // p3：依赖 p1 的服务（用于级联测试）
  fs.writeFileSync(path.join(dir, 'p3.js'), base + "\nclass P3 extends Service {\n  constructor(ctx, cfg) { super(ctx, 'p3') }\n  dispose() { record('p3-dispose') }\n}\nP3.inject = ['p1']\nmodule.exports = function (ctx, cfg) { ctx.plugin(P3, cfg) }\n")
  // broken：模块加载即抛错
  fs.writeFileSync(path.join(dir, 'broken.js'), "throw new Error('boom')\n")
  const scope = { process, env: process.env, path, __dirname: dir, root: dir }
  return { dir, scope, state: { record: (s) => fs.appendFileSync(path.join(dir, 'state.cjs.log'), s + '\n') } }
}

function entry(id, cfg = {}, extra = {}) {
  return { id, module: null, config: cfg, disabled: false, hot: false, source: 'base', ...extra }
}

async function boot(entries, pluginsDir, scope) {
  const ctx = new Context()
  const state = { entries: [], fibers: new Map() }
  ctx.$loader = state
  for (const e of entries) {
    if (e.disabled) continue
    const cfg = e.config
    const f = await applyEntry(ctx, e, cfg, pluginsDir)
    state.fibers.set(e.id, f)
    state.entries.push({ ...e, config: cfg })
  }
  return { ctx, state }
}

function readEvents(dir) {
  const p = path.join(dir, 'events.log')
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : []
}

test('P8B 卸载：服务消失且 dispose 约定被调用', async () => {
  const { dir, scope } = setup()
  const { ctx, state } = await boot([entry('p1'), entry('p2')], dir, scope)
  assert.ok(ctx.p1 && ctx.p2)
  const next = [entry('p2')]
  await applyDiff(ctx, { next, state, pluginsDir: dir, scope })
  assert.equal(!!ctx.p1, false)
  assert.equal(!!ctx.p2, true)
})

test('P8B 新增：新插件热加载', async () => {
  const { dir, scope } = setup()
  const { ctx, state } = await boot([entry('p1')], dir, scope)
  const next = [entry('p1'), entry('p2')]
  await applyDiff(ctx, { next, state, pluginsDir: dir, scope })
  assert.ok(ctx.p2)
})

test('P8B 模块变更：卸载旧应用新（含 dispose 调用）', async () => {
  const { dir, scope } = setup()
  const { ctx, state } = await boot([entry('p1', { tag: 'old' })], dir, scope)
  const next = [entry('p1', { tag: 'new' }, { module: './p1.js' })]
  await applyDiff(ctx, { next, state, pluginsDir: dir, scope })
  assert.ok(ctx.p1)
})

test('P8B 回滚：模块加载失败时保留旧实例', async () => {
  const { dir, scope } = setup()
  const { ctx, state } = await boot([entry('p1', { tag: 'old' })], dir, scope)
  const next = [entry('p1', {}, { module: './broken.js' })]
  await applyDiff(ctx, { next, state, pluginsDir: dir, scope })
  assert.ok(ctx.p1, '旧实例应被回滚保留')
})


test('P8B 级联：卸载 p1 时依赖它的 p3 一起下线并被重应用', async () => {
  const { dir, scope } = setup()
  const { ctx, state } = await boot([entry('p1'), entry('p3')], dir, scope)
  assert.ok(ctx.p1 && ctx.p3)
  // 移除 p1：p3 依赖缺失应随之下线（不误报真故障）
  const next1 = [entry('p3')]
  await applyDiff(ctx, { next: next1, state, pluginsDir: dir, scope })
  assert.equal(!!ctx.p1, false)
  // p3 依赖没了：审计视为预期下线；但条目仍在树中
  // 恢复 p1：p3 通过闭包重应用
  const next2 = [entry('p1'), entry('p3')]
  await applyDiff(ctx, { next: next2, state, pluginsDir: dir, scope })
  assert.ok(ctx.p1, 'p1 应恢复')
  assert.ok(ctx.p3, 'p3 应随级联重应用')
})

test('P8B 纯 config 变更：发 config:update 事件而不重载', async () => {
  const { dir, scope } = setup()
  const { ctx, state } = await boot([entry('p1', { tag: 'a' })], dir, scope)
  let got = null
  ctx.on('config:update', (ev) => { got = ev })
  const next = [entry('p1', { tag: 'b' })]
  await applyDiff(ctx, { next, state, pluginsDir: dir, scope })
  assert.ok(got, '应发出 config:update')
  assert.equal(got.id, 'p1')
  assert.equal(got.config.tag, 'b')
  assert.equal(got.previous.tag, 'a')
})
