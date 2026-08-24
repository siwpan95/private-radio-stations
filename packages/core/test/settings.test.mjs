// @relay/core settings 单测：三层合并 / 乐观锁 / 脱敏 / 持久化
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Schema from 'schemastery'
import { Context, Service } from 'cordis'
import settingsPlugin, { redactSecrets } from '../src/settings.js'

class FakeConfig extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'config')
    Object.assign(this, cfg);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeCtx(dir) {
  const ctx = new Context();
  ctx.plugin(FakeConfig, { root: dir });
  ctx.plugin(settingsPlugin, { watch: false });
  return ctx;
}

const SchemaNs = Schema.object({
  flag: Schema.boolean().default(false),
  num: Schema.number().default(1),
});

test('三层合并：默认 -> base -> 用户文档', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-'));
  const ctx = makeCtx(dir);
  await tick();
  ctx.settings.register('demo', SchemaNs, { base: { flag: true } });
  let r = ctx.settings.resolve('demo');
  assert.equal(r.value.flag, true);  // base 覆盖默认
  assert.equal(r.value.num, 1);     // schema 默认
  r = ctx.settings.set('demo', { num: 42 });
  assert.equal(r.value.num, 42);
  assert.equal(r.value.flag, true); // 未覆盖的键保留 base 值
});

test('revision 乐观锁：旧 revision 写入抛 SETTINGS_CONFLICT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-'));
  const ctx = makeCtx(dir);
  await tick();
  ctx.settings.register('demo', SchemaNs);
  const r1 = ctx.settings.set('demo', { num: 1 });  // revision 1
  assert.throws(() => ctx.settings.set('demo', { num: 2 }, r1.revision - 1), (e) => e.code === 'SETTINGS_CONFLICT');
  const ok = ctx.settings.set('demo', { num: 2 }, r1.revision);  // 带正确 revision 成功
  assert.equal(ok.value.num, 2);
  assert.equal(ok.revision, 2);
});

test('持久化：重启后（新实例）读到用户文档', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-'));
  const ctx = makeCtx(dir);
  await tick();
  ctx.settings.register('demo', SchemaNs);
  ctx.settings.set('demo', { num: 7 });
  const ctx2 = makeCtx(dir);
  await tick();
  ctx2.settings.register('demo', SchemaNs);
  assert.equal(ctx2.settings.resolve('demo').value.num, 7);
});

test('快照深冻结', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-'));
  const ctx = makeCtx(dir);
  await tick();
  ctx.settings.register('demo', SchemaNs);
  const r = ctx.settings.resolve('demo');
  assert.ok(Object.isFrozen(r.value));
  assert.throws(() => { r.value.flag = true; }); // 严格模式静默失败，这里验证 frozen 状态即可
});

test('redactSecrets 脱敏', () => {
  const out = redactSecrets({ token: 'abc', nested: { apiKey: 'x', keep: 1 } });
  assert.equal(out.token, '***');
  assert.equal(out.nested.apiKey, '***');
  assert.equal(out.nested.keep, 1);
});