// @relay/core loader 单测：P6 归一化 / P7 compose / P8A diff
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEntries, composeEntries, diffEntries } from '../src/loader.js'

test('P6 行式数组直接归一化', () => {
  const { entries, legacy } = normalizeEntries({ plugins: [
    { id: 'a', config: { x: 1 } },
    { id: 'b', module: './x.js', disabled: true, hot: true },
  ] })
  assert.equal(legacy, false)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { id: 'a', module: null, config: { x: 1 }, disabled: false, hot: false, source: 'base' })
  assert.equal(entries[1].disabled, true)
  assert.equal(entries[1].hot, true)
})

test('P6 旧 map 形式兼容并标记 legacy', () => {
  const { entries, legacy } = normalizeEntries({ plugins: { a: { x: 1 }, b: null } })
  assert.equal(legacy, true)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].id, 'a')
  assert.deepEqual(entries[1].config, {})
})

test('P6 缺 id 的行报错', () => {
  assert.throws(() => normalizeEntries({ plugins: [{ config: {} }] }), /缺少 id/)
})

test('P7 patch 覆盖 config（浅层合并）', () => {
  const base = normalizeEntries({ plugins: [{ id: 'a', config: { p: 1, q: { deep: 1 } } }] }).entries
  const out = composeEntries(base, [{ id: 'a', config: { p: 99 } }])
  assert.equal(out[0].config.p, 99)
  assert.deepEqual(out[0].config.q, { deep: 1 })
  assert.equal(out[0].source, 'patch')
})

test('P7 patch 插入（before 锚点）与禁用开关', () => {
  const base = normalizeEntries({ plugins: [{ id: 'a' }, { id: 'b' }] }).entries
  const out = composeEntries(base, [
    { id: 'x', before: 'b' },
    { id: 'a', disabled: true },
  ])
  assert.deepEqual(out.map((e) => e.id), ['a', 'x', 'b'])
  assert.equal(out.find((e) => e.id === 'a').disabled, true)
  assert.equal(out.find((e) => e.id === 'x').source, 'patch')
})

test('P7 patch 未知 id 且无锚点 -> 追加', () => {
  const base = normalizeEntries({ plugins: [{ id: 'a' }] }).entries
  const out = composeEntries(base, [{ id: 'z', config: { n: 1 } }])
  assert.deepEqual(out.map((e) => e.id), ['a', 'z'])
})

test('P8A diff：added/removed/changed 识别', () => {
  const prev = [
    { id: 'a', config: { x: 1 }, disabled: false, module: null },
    { id: 'gone', config: {}, disabled: false, module: null },
  ]
  const next = [
    { id: 'a', config: { x: 2 }, disabled: false, module: null },
    { id: 'new', config: {}, disabled: false, module: null },
  ]
  const d = diffEntries(prev, next)
  assert.deepEqual(d.added.map((e) => e.id), ['new'])
  assert.deepEqual(d.removed.map((e) => e.id), ['gone'])
  assert.equal(d.changed.length, 1)
  assert.equal(d.changed[0].next.config.x, 2)
})

test('P8A diff：config 未变不报 changed', () => {
  const prev = [{ id: 'a', config: { x: 1 }, disabled: false, module: null }]
  const next = [{ id: 'a', config: { x: 1 }, disabled: false, module: null }]
  assert.equal(diffEntries(prev, next).changed.length, 0)
})
