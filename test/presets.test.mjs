// presets 读写单测（node:test，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import presetsPlugin from '../src/plugins/presets.js'

class FakeConfig extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'config')
    Object.assign(this, cfg)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function makeCtx(file) {
  const ctx = new Context()
  ctx.plugin(FakeConfig, { presetsFile: file })
  ctx.plugin(presetsPlugin)
  return ctx
}

test('空文件 -> 空列表', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-presets-'))
  const file = path.join(dir, 'presets.json')
  const ctx = makeCtx(file)
  await tick()
  assert.deepEqual(ctx.presets.list(), [])
})

test('add 写入并按 url 去重', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-presets-'))
  const file = path.join(dir, 'presets.json')
  const ctx = makeCtx(file)
  await tick()
  const p = ctx.presets
  let list = p.add('台A', 'http://a/stream')
  assert.equal(list.length, 1)
  list = p.add('台A重名', 'http://a/stream')
  assert.equal(list.length, 1, '同 url 不应重复')
  list = p.add('台B', 'http://b/stream')
  assert.equal(list.length, 2)
  // 落盘且可重读
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.length, 2)
})

test('remove 按 url 删除', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-presets-'))
  const file = path.join(dir, 'presets.json')
  const ctx = makeCtx(file)
  await tick()
  const p = ctx.presets
  p.add('台A', 'http://a/stream')
  p.add('台B', 'http://b/stream')
  const list = p.remove('http://a/stream')
  assert.equal(list.length, 1)
  assert.equal(list[0].url, 'http://b/stream')
})
