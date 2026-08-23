// channels.parseM3u 单测（node:test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseM3u } from '../src/plugins/channels.js'

const SAMPLE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-name="CCTV1" tvg-logo="http://l/1.png" group-title="央视频道",CCTV-1',
  'http://a/1.m3u8',
  '#EXTINF:-1 tvg-id="CCTV1.cn",CCTV-1 (720p)',
  'http://b/1.m3u8',
  '#EXTINF:-1 group-title="央视频道",CCTV-2',
  'http://a/2.m3u8',
  '#EXTINF:-1,CCTV-2',
  'http://a/2.m3u8',
  '#EXTINF:-1,坏频道',
  '# 注释行',
].join('\n')

test('同频道多源合并（含 (720p) 后缀归一）', () => {
  const list = parseM3u(SAMPLE)
  assert.equal(list.length, 2)
  const cctv1 = list.find((c) => c.name === 'CCTV-1')
  assert.deepEqual(cctv1.urls, ['http://a/1.m3u8', 'http://b/1.m3u8'])
  assert.equal(cctv1.group, '央视频道')
  assert.equal(cctv1.logo, 'http://l/1.png')
  assert.equal(cctv1.tvgId, 'CCTV1.cn')
})

test('重复 URL 去重', () => {
  const list = parseM3u(SAMPLE)
  const cctv2 = list.find((c) => c.name === 'CCTV-2')
  assert.deepEqual(cctv2.urls, ['http://a/2.m3u8'])
})

test('无 URL 的频道被过滤', () => {
  const list = parseM3u('#EXTM3U\n#EXTINF:-1,坏频道\n# 注释\n')
  assert.equal(list.length, 0)
})

test('空文本返回空列表', () => {
  assert.deepEqual(parseM3u(''), [])
})
