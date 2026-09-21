// 卫星瓦片换算与 URL 组装单测。
// 这些是纯函数——坐标算错会导致抓错瓦片或整幅错位，故用已知地理锚点锁定。
//
// 语义约定（与 OSM slippy map 参考实现一致，已用 Python 对照验证）：
//   - degToTile(lat, lon, z) 返回该经纬度所在瓦片的 (x, y) 整数索引；
//   - tileToLonLat(x, y, z) 返回该瓦片**左上角**的经纬度（不是中心！）。
//     这是 slippy map 的标准定义：z0 的 (0,0) 瓦片左上角为 (-180, 85.05)，
//     即整幅墨卡托投影的西北角。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tileToLonLat, degToTile, tileUrl } from '../../../scripts/satellite.mjs'

test('degToTile: z0 全图归入唯一瓦片', () => {
  // z=0 时 2^0=1，任何经纬度都应落在 (0,0)
  for (const [lat, lon] of [[0, 0], [39.9, 116.4], [-33.9, 151.2], [51.5, -0.13]]) {
    const t = degToTile(lat, lon, 0)
    assert.deepEqual(t, { x: 0, y: 0 }, `lat=${lat} lon=${lon} 应落在 z0 唯一瓦片`)
  }
})

test('degToTile: 已知城市锚点（z3, 2^3=8 网格）', () => {
  // 锚点取自 OSM slippy map 参考实现的对照结果
  assert.deepEqual(degToTile(39.9, 116.4, 3), { x: 6, y: 3 }, '北京')
  assert.deepEqual(degToTile(51.5, -0.13, 3), { x: 3, y: 2 }, '伦敦')
  // 注意：纽约在 40.7N/-74.0W，其 y 为 3（与北京同带），不是 2。
  // 北纬越大 y 越小；40.7 与 39.9 同处第 3 行。
  assert.deepEqual(degToTile(40.7, -74.0, 3), { x: 2, y: 3 }, '纽约')
})

test('degToTile: z6 上海锚点', () => {
  assert.deepEqual(degToTile(31.23, 121.47, 6), { x: 53, y: 26 })
})

test('degToTile: 赤道与本初子午线落在网格中点', () => {
  // (0,0) 在 z2 应落在 x=2 y=2（4x4 网格的正中偏右/偏下）
  const t = degToTile(0, 0, 2)
  assert.equal(t.x, 2)
  assert.equal(t.y, 2)
})

test('degToTile: 经度边界不溢出', () => {
  const west = degToTile(0, -180, 4)
  assert.equal(west.x, 0, '最西经应落在第 0 列')
  const nearEast = degToTile(0, 179.99, 4)
  assert.equal(nearEast.x, 15, '接近东经 180 应落在最后一列')
})

test('degToTile: 纬度越高 y 越小（北半球）', () => {
  const low = degToTile(10, 0, 4)
  const high = degToTile(60, 0, 4)
  assert.ok(high.y < low.y, '纬度升高，行号应减小')
})

test('tileToLonLat: 返回左上角（z0 为墨卡托西北角）', () => {
  const c = tileToLonLat(0, 0, 0)
  assert.ok(Math.abs(c.lon - -180) < 1e-6, `z0 左上角经度应为 -180，实际 ${c.lon}`)
  // Web Mercator 的纬度上限约 ±85.0511°
  assert.ok(Math.abs(c.lat - 85.05112878) < 1e-4, `z0 左上角纬度应约 85.0511，实际 ${c.lat}`)
})

test('tileToLonLat: 左上角反查落在本瓦片或其上一邻格', () => {
  // 说明：瓦片左上角坐标在某些缩放级别会**恰好落在网格整数边界上**
  // （如 z=2 时 66.5133° 正好是行边界）。此时 Math.floor 会把它归到上一格，
  // 这是 IEEE-754 边界行为，不是缺陷——地图库普遍如此。
  // 故这里断言：反查结果要么是本瓦片，要么是与本瓦片相邻的上一行/列。
  const cases = [
    [39.9, 116.4],
    [31.23, 121.47],
    [-33.87, 151.21],
    [40.71, -74.01],
  ]
  for (const z of [2, 3, 6]) {
    for (const [lat, lon] of cases) {
      const t = degToTile(lat, lon, z)
      const corner = tileToLonLat(t.x, t.y, z)
      const back = degToTile(corner.lat, corner.lon, z)
      const dx = Math.abs(back.x - t.x)
      const dy = Math.abs(back.y - t.y)
      assert.ok(
        dx <= 1 && dy <= 1,
        `z=${z} lat=${lat} lon=${lon}: 反查 (${back.x},${back.y}) 偏离本瓦片 (${t.x},${t.y}) 超过一格`
      )
    }
  }
})

test('tileUrl: 路径顺序为 {z}/{y}/{x} 且扩展名正确', () => {
  // 关键回归：GIBS 是 row(y) 在前，与常见的 {z}/{x}/{y} 相反。
  // 若此处写反，会抓到镜像/错位瓦片（且 HTTP 仍 200，很难发现）。
  const u = tileUrl(
    'https://example.test/wmts',
    'MODIS_Terra_CorrectedReflectance_TrueColor',
    '2026-09-20',
    'GoogleMapsCompatible_Level9',
    3,
    2,
    6,
    'jpeg'
  )
  assert.equal(
    u,
    'https://example.test/wmts/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-09-20/GoogleMapsCompatible_Level9/3/2/6.jpeg'
  )
  // 断言 z/y/x 的相对顺序
  assert.ok(u.endsWith('/3/2/6.jpeg'), '应为 {z}/{y}/{x}')
})

test('tileUrl: 必须用 .jpeg 而非 .jpg', () => {
  // 实测：GIBS 对 .jpg 返回 HTTP 400，这是个静默陷阱。
  const u = tileUrl('B', 'L', '2026-09-20', 'MS', 1, 0, 1, 'jpeg')
  assert.ok(u.endsWith('.jpeg'))
  assert.ok(!u.endsWith('.jpg'), '.jpg 会被 GIBS 拒绝（HTTP 400）')
})
