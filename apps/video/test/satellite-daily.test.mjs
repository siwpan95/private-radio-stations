// satellite-daily.mjs 编排逻辑单测：配置解析 / 日期戳命名 / 历史裁剪。
// 这些是纯函数，不触碰网络与 ffmpeg，用临时文件锁定行为，避免回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  parseSatelliteConfig,
  datedOutfile,
  pruneOld,
  todayIso,
} from '../../../scripts/satellite-daily.mjs'

function writeTempYml(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'satcfg-'))
  const p = path.join(dir, 'cordis.yml')
  fs.writeFileSync(p, body)
  return { dir, p }
}

test('parseSatelliteConfig: yml 缺失时回退默认值', () => {
  const cfg = parseSatelliteConfig(path.join(os.tmpdir(), 'no-such-cordis.yml'))
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.auto, true)
  assert.equal(cfg.source, 'modis')
  assert.equal(cfg.zoom, 3)
  assert.equal(cfg.days, 5)
  assert.equal(cfg.hour, 3)
  assert.equal(cfg.keep, 7)
})

test('parseSatelliteConfig: 解析自定义段（含行内注释与引号）', () => {
  const { p } = writeTempYml(`plugins:
  - id: config
    config:
      port: 8100
      satellite:
        enabled: true
        dir: satellite        # 成品目录
        source: "viirs"       # 引号+注释
        zoom: 4               # 0..9
        days: 7
        auto: false           # 关闭自动
        hour: 22
        keep: 14
  - id: web
`)
  const cfg = parseSatelliteConfig(p)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.auto, false)
  assert.equal(cfg.dir, 'satellite')
  assert.equal(cfg.source, 'viirs')
  assert.equal(cfg.zoom, 4)
  assert.equal(cfg.days, 7)
  assert.equal(cfg.hour, 22)
  assert.equal(cfg.keep, 14)
})

test('parseSatelliteConfig: 段缺失时回退默认值（仅含其它键）', () => {
  const { p } = writeTempYml(`plugins:
  - id: config
    config:
      port: 8100
  - id: web
`)
  const cfg = parseSatelliteConfig(p)
  assert.equal(cfg.source, 'modis')
  assert.equal(cfg.keep, 7)
  assert.equal(cfg.hour, 3)
})

test('parseSatelliteConfig: 边界钳制（hour/keep 越界）', () => {
  const { p } = writeTempYml(`plugins:
  - id: config
    config:
      satellite:
        hour: 99
        keep: 0
`)
  const cfg = parseSatelliteConfig(p)
  assert.equal(cfg.hour, 23, 'hour 越界应钳到 23')
  assert.equal(cfg.keep, 1, 'keep 越界应钳到 1')
})

test('todayIso: 返回本地 YYYY-MM-DD', () => {
  const d = new Date(2026, 8, 21, 23, 59) // 2026-09-21 本地
  assert.equal(todayIso(d), '2026-09-21')
})

test('datedOutfile: 命名格式与日期参数', () => {
  const f = datedOutfile('/x/y/satellite', '2026-09-21')
  assert.equal(f, path.join('/x/y/satellite', 'satellite-2026-09-21.mp4'))
  // 默认取今天
  assert.ok(datedOutfile('/x').endsWith('.mp4'))
})

test('pruneOld: 保留最近 keep 份，裁剪更早的', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'satprune-'))
  try {
    // 制造 9 份按日期升序的成品 + 1 份日志
    const dates = []
    for (let i = 1; i <= 9; i++) {
      const ds = `2026-09-${String(i).padStart(2, '0')}`
      dates.push(ds)
      fs.writeFileSync(path.join(dir, `satellite-${ds}.mp4`), 'x')
    }
    fs.writeFileSync(path.join(dir, '.daily-2026-09-01.log'), 'x')
    const removed = pruneOld(dir, 7)
    // 9 份 -> 保留最近 7 -> 删 2 份（2026-09-01, 2026-09-02）
    assert.equal(removed.length, 2)
    assert.ok(!fs.existsSync(path.join(dir, 'satellite-2026-09-01.mp4')))
    assert.ok(!fs.existsSync(path.join(dir, 'satellite-2026-09-02.mp4')))
    assert.ok(fs.existsSync(path.join(dir, 'satellite-2026-09-09.mp4')))
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).length, 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruneOld: 目录不存在安全返回空', () => {
  assert.deepEqual(pruneOld(path.join(os.tmpdir(), 'no-such-sat-dir-xyz'), 7), [])
})
