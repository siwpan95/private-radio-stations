# 免费卫星图像数据源评估（本机实测 2026-09-21）

> 状态：**已实施（路径 A：离线渲染 + 点播转播）**。所有结论均基于本机真实网络探测
> 与 ffmpeg 实测，非文档摘抄。用途定位：**作为转播内容**，接入现有 `apps/video` 的
> ffmpeg → MediaMTX 管线。
>
> 实现入口：`scripts/satellite.mjs`（`npm run satellite`），
> 详见下方 §六「实施说明」。

## 一、结论摘要（先说要点）

**技术上可行，但存在两个必须接受的硬约束**，它们决定了实现形态：

1. **没有「现成的卫星视频流」可转播**。NASA/NOAA 提供的全部是**静态图像或瓦片**，
   不存在可直接 `-i <url>` 拉取的 HLS/RTSP 卫星直播源。因此必须由**本项目自己合成视频**
   ——即在 ffmpeg 用 `-loop 1` 循环静帧，或按时间序拉多帧拼成动画。
   （唯一的例外是 NASA TV 的 HLS，但其 CDN `ntv1.akamaihd.net` 在本机 **DNS 解析失败**，见 §二。）

2. **合成视频必须转码，且本机 CPU 是瓶颈，且无硬件编码可救**。实测「单张 JPEG 循环 → H.264 推流」
   的速度**远低于实时**（`speed=0.028x ~ 0.303x`，即 1 秒画面要算 3~33 秒）。
   硬件编码（NVENC/QSV/AMF）**实测全部不可用**（§4.2），故无法提速。
   1920×1080 级别的实时卫星频道**在本机不可行**；即便降到 480p @ 0.5fps
   也只有 0.303x，**仍不达实时**。

**推荐取舍（明确结论）**：本项目**不应**把卫星图像做成「实时直播频道」——
本机无硬件编码，纯软件编码下 `-loop 1` 无论怎么降规格都跑不到 1.0x。
正确做法是**路径 A：离线渲染 + 点播转播**。卫星影像本身是「每日/每十分钟」级更新，
并非逐秒直播，离线渲染完全契合其数据节奏，且**无需改动现有 `streamer.js`**。

## 二、源可达性实测

本机网络有严格限制（见 `docs/NETWORK.md`）。逐个实测结果：

| 数据源 | 可达 | 实测证据 | 许可 |
|--------|------|----------|------|
| **NASA GIBS**（WMTS 瓦片） | ✅ | 能力文档 5.78 MB；瓦片 200 | 公有领域 |
| **NASA EPIC**（DSCOVR 地球全景） | ✅ | API 200 / 13 帧；PNG 2.68 MB | 公有领域 |
| **NOAA GOES**（静止卫星全盘图） | ✅ | 1808² 1.69 MB；5424² 9.77 MB | 公有领域 |
| GIBS GeoColor 图层 | ✅ | z7 瓦片 200 / 139 KB (PNG) | 公有领域 |
| tile.openstreetmap.org | ❌ | `WinError 10061` 积极拒绝 | — |
| NASA TV HLS (akamaihd) | ❌ | `getaddrinfo failed` DNS 失败 | — |
| Wikimedia Commons | ❌ | TLS 握手超时 | — |
| sentinel-cogs (AWS S3) | ❌ | HTTP 404 | — |

**三者均可免费、免注册、免 API Key**，符合「完全免费且免注册」的要求。

## 三、关键源的正确调用格式（已实测）

### 3.1 NASA GIBS — MODIS 真彩瓦片

```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/
  {layer}/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg
```

- `layer` 例：`MODIS_Terra_CorrectedReflectance_TrueColor`（还有 8 个真彩图层可选）
- `date` 例：`2026-09-20`（`YYYY-MM-DD`）
- **瓦片矩阵固定为 `GoogleMapsCompatible_Level9`，即最大 z=9**（约 0.7 km/像素）
- **扩展名必须是 `.jpeg`，不是 `.jpg`**（用 `.jpg` 会得到 `HTTP 400`）
- 注意瓦片路径顺序是 **`{z}/{y}/{x}`**（**row 在前**，与常见 `{z}/{x}/{y}` 相反）

**⚠️ 数据发布延迟（重要）**：图层默认时间是「今天」，但**当天数据尚未发布**。
实测 2026-09-21 当天瓦片为空白；回退 1 天（09-20）即返回真实影像，此后逐日皆有数据。
**生产代码必须使用 `today - 1` 或更早**，否则得到全白画面。

> 排查记录：这个「日期延迟」最初被误判为「西半球被地域封锁」——因为当天采样时，
> 180°W~0° 全部返回同一个空白瓦片（md5 `f919d4e9`），而 45°E~135°E 有影像。
> 换用历史日期 2024-01-15 采样美国瓦片得到 17.7 KB 真实影像，**推翻了地域封锁的假设**，
> 确认根因只是当天未发布。若不做这个对照实验，会得出完全错误的结论。

### 3.2 NASA EPIC — 地球全景（DSCOVR，拉格朗日 L1 点）

```
https://epic.gsfc.nasa.gov/api/natural            # 最近 13 帧元数据
https://epic.gsfc.nasa.gov/api/natural/available  # 可选日期（最早 2015-06-13）
https://epic.gsfc.nasa.gov/archive/natural/{YYYY}/{MM}/{DD}/png/{image}.png
```

- `image` 字段取自 API 返回，如 `epic_1b_20260917000831`
- 单帧 PNG 约 2.68 MB；**自带 `caption` 与 `centroid_coordinates`**，适合做字幕/标注
- 历史日期覆盖 2015 至今，**适合做延时动画**

### 3.3 NOAA GOES — 静止卫星全盘

```
https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR/1808x1808.jpg
https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR/5424x5424.jpg
```

- **仅有两档分辨率实装**：`1808x1808`（1.69 MB）与 `5424x5424`（9.77 MB）。
  `1200x1200` / `600x600` **不存在**（404），不要写进配置。
- `GEOCOLOR` 是真彩合成产品，视觉效果好；`FD` = Full Disk（全盘）。
- SAT 后缀可换 `GOES16`/`GOES19`。GOES-East 覆盖美洲，**对中国区域覆盖有限**。

## 四、ffmpeg 集成可行性实测

现有 `streamer.js` 用 `-c copy` 直转。**对卫星图像这条路走不通**，原因：

单张 JPEG 被 ffmpeg 识别为 `image2` 输入，**时长仅 0.04 秒、只有 1 帧**：

```
Input #0, image2, from 'https://cdn.star.nesdis.noaa.gov/.../5424x5424.jpg':
  Duration: 00:00:00.04, start: 0.000000
  Stream #0:0: Video: mjpeg, 5424x5424, 25 fps
```

若直接交给 `streamer.js`，ffmpeg 会**立刻正常退出**，`station` 状态机将判定为
「短命退出 → 拉流失败」并触发 failover 重试，形成无意义的循环。

### 4.1 `-loop 1` 方案实测数据

用 `-loop 1 -framerate N -i <url>` 把静帧变成持续流，必然要转码。实测：

| 配置 | 输出 | 墙钟 | **speed** | 结论 |
|------|------|------|-----------|------|
| 1808² → 960p, 5fps, 4s | 1.18 MB | 140 s | **0.028x** | 不可用 |
| 1808² → 480p, 0.5fps, 10s | 374 KB | 51.9 s | **0.303x** | 峰值，仍非实时 |
| 1808² → 854p, 1fps, 10s | 1.39 MB | 86.0 s | **0.164x** | 不可用 |

**决定性结论**：`-loop 1` 的瓶颈**不在缩放，而在「同一张图反复编码」的开销**——
因为每帧都要走完整的 libx264 编码流程。降低分辨率能把 speed 从 0.028x 提升到 0.303x
（约 10 倍），但**仍然 < 1.0x，即无法实时**。

即使最快的 480p/0.5fps 配置也只有 0.303x，意味着**播 1 秒需算 3.3 秒**，
画面会持续落后、缓冲越积越多。**这不能作为「实时直播频道」交付。**

### 4.2 硬件编码可行性（已实测，结论：不可用）

ffmpeg 虽**编译进了**全部硬件编码器（`h264_nvenc` / `h264_qsv` / `h264_amf`），
但**本机均无法实际使用**。逐个实测结果：

| 编码器 | 结果 | 确切错误 |
|--------|------|----------|
| `h264_nvenc` | **超时**（150 s 未完成） | 无 NVIDIA GPU |
| `h264_qsv` | 失败 rc=2981409195 | `Error creating a MFX session: -9.` |
| `h264_amf` | 失败 rc=2981409195 | `DLL amfrt64.dll failed to open` |

- QSV 的 `MFX session -9` 表示**无可用 Intel 核显或驱动**；
- AMF 的 `amfrt64.dll failed to open` 表示**无 AMD 显卡驱动**；
- NVENC 挂起表示**无 NVIDIA 硬件**。

**结论：本机没有任何可用的硬件编码路径**，路径 C 被排除。
（注：`-encoders` 列出编码器只代表「编译时启用了」，**不代表硬件存在**——
这是一个常见误判点，必须实测。）

### 4.3 可行的替代路径

| 路径 | 做法 | 实时性 | 画质 | 适用 |
|------|------|--------|------|------|
| **A 离线渲染** | 拉 N 帧 → 离线拼成 mp4 → 当点播源转播 | 不要求 | 高 | ✅ **推荐** |
| **B 极低帧率** | 480p @ 0.5fps `-loop 1` | 0.303x，**不达实时** | 低 | ⚠️ 勉强，不推荐 |
| ~~C 硬件编码~~ | ~~NVENC/QSV/AMF~~ | — | — | ❌ **实测不可用** |
| **D 预生成静态图** | 只播一张图，前端做 Ken Burns 动画 | 前端实时 | 高 | 若接受静态 |

**路径 A（离线渲染）是最务实的选择**：卫星影像本身更新频率就是「每天/每 10 分钟」，
并非每秒变化的直播。做法是**定时任务**（如每小时）拉取最新帧，离线用 ffmpeg 渲成
一段 H.264 mp4，再由现有 `station`/`streamer` 以 `-c copy` 播放。这样：
- 绕开实时编码瓶颈（离线渲染慢一点无所谓）；
- 天然契合现有 `-c copy` 直转路径，**无需改动 `streamer.js`**；
- 画质可以给足（1080p 无压力）。

## 五、法律与许可

- **GIBS / EPIC / GOES 均为美国政府作品，属公有领域**（NASA/NOAA 数据政策），
  可自由使用、再分发、商用，**无需署名**（署名仍属良好实践）。
- 无 API Key、无注册、无速率合约限制，但**应自觉限流**避免对公共服务造成压力。
  脚本内置 120ms 串行间隔即为此。
- **不使用** OpenStreetMap 瓦片（本机亦不可达）——OSM 有 tile usage policy，
  批量拉取违反其可接受使用政策。
- Sentinel（ESA Copernicus）理论上是免费开放数据，本机不可达，未纳入。

## 六、实施说明（路径 A，已落地）

### 6.1 用法

```bash
npm run satellite                      # 默认 modis 源、today-1、zoom3、单日
npm run satellite -- --days 5          # 连续 5 天 → 延时动画 + lighten 混合图
npm run satellite -- --zoom 2          # 降低缩放级别（更省流量）
npm run satellite -- --date 2026-09-19 # 指定日期
npm run satellite -- --source weld     # 换源（modis / viirs / weld）
npm run satellite:list                 # 列出内置源
```

产出（默认 `apps/video/satellite/`，已加入 `.gitignore`）：
- `satellite.mp4` —— 延时视频（多日时）
- `satellite-blend.png` —— 多日 lighten 混合静帧
- `satellite.png` —— 单日时的静态图

### 6.2 接入转播

由 `scripts/satellite.mjs` 生成的 mp4 走**现有 `-c copy` 点播路径**，
**无需改动 `streamer.js`**。两种接入方式：

- 面板「手动 URL」填 `file:///<绝对路径>`；
- 或写入 `apps/video/presets.json`，**务必带 `live: false`**
  （否则播完会被 `station` 判为直播断流而反复重试）。

`/api/status` 新增 `satellite` 字段，列出已生成的成品供面板发现。

### 6.3 实现中的三个关键坑（均已在代码中规避）

1. **GIBS 当天数据未发布** → 脚本默认取 `today - 1`；若仍全白会明确报错提示改日期。
2. **GIBS 图像扩展名必须 `.jpeg`**（`.jpg` → HTTP 400）→ 脚本常量固定 + 单测锁定。
3. **本机 ffmpeg 不支持 `-pattern_type glob`**
   （实测报 `globbing is not supported by this libavformat build`）→
   改用编号序列 `frame_%04d.png`。

### 6.4 MODIS 条带缝隙的处理

MODIS 是极轨卫星，**单日影像存在斜向条带缝隙**（相邻轨道间未扫描到的楔形空区，
拼图上表现为黑带）。这是数据固有特性，非缺陷。脚本用 **多日 `blend=lighten` 叠加**
（缺失处为黑，会被邻日真实影像取代）显著减轻缝隙——实测 2 日即明显改善，5 日更好。

**对照实验（重要）**：另测试了 Landsat WELD「无缝年度/月度合成」图层，
结果发现它**虽有缝但有大量块状黑色空洞**（Landsat 幅宽窄 + 云覆盖所致），
综合观感**不如** MODIS 多日混合。故默认源定为 `modis`，`weld` 仅作备选。

### 6.5 配置项

`apps/video/cordis.yml` 的 `config` 行新增 `satellite` 段：

```yaml
satellite:
  enabled: true
  dir: satellite     # 成品目录（相对 apps/video）
  source: modis      # modis | viirs | weld
  zoom: 3            # 0..9
  days: 5            # 多日合成天数
```

## 七、未决事项

- **GOES 对中国覆盖不足**：若目标观众在国内，GOES-East（美洲）与 EPIC（全球但分辨率有限）
  的可用性需重新评估；GIBS 全球瓦片是更合适的基础（当前默认即为 GIBS）。
- **是否需要音频轨**：卫星画面默片。若要接入现有 HLS/RTSP 输出，需确认
  MediaMTX 对纯视频轨的处理（现有 `streamer.js` 用 `-map 0:a:0?` 容忍无音轨）。
- **硬件编码已排除**（§4.2 实测），故「实时卫星频道」这条路在本机确定不可行。
  若将来换机，可重跑 §4.2 的三个编码器测试；若届时可用，可考虑加一条实时 `satellite` 源。
- **每日自动生成（已落地，见 §八）**：无需再手动 `npm run satellite`；
  由 cordis 调度服务与 WorkBuddy 定时自动化双重冗余触发，成品按日期戳命名并自动裁剪。

## 八、每日自动生成（双重调度冗余，已落地）

### 8.1 为什么是两条链路

单条链路存在明确的失效场景：cordis 调度服务只在应用进程存活时有效（进程退出当天即漏跑）；
外部自动化只在调度器存活时有效（机器重装 / WorkBuddy 未启动则失效）。
因此采用**互为冗余**而非二选一：

1. **cordis 调度服务** `apps/video/src/plugins/satelliteScheduler.js`
   —— 随 `video` 应用启动，按墙钟 `hour:00` 触发；若当日该时刻已过（启动晚），
   则 5 分钟后补跑一次。
2. **WorkBuddy 定时自动化** —— 每日 03:00 在项目根目录执行 `npm run satellite:daily`。

两条链路共用同一个脚本 `scripts/satellite-daily.mjs`，脚本内置**进程锁**
（`.run.lock`，锁龄 < 6 小时视为「仍在进行中」直接退出），因此即使两条链路
同时触发也只会真正生成一次，不会重复下载 GIBS 瓦片。

### 8.2 脚本职责

`scripts/satellite-daily.mjs`（`npm run satellite:daily`）：

1. 读 `apps/video/cordis.yml` 的 `satellite` 段（纯文本切片解析，规避 `!!js` 标签）；
2. 以当天日期戳命名成品：`satellite-YYYY-MM-DD.mp4`；
3. 额外复制一份为 `satellite.mp4`（稳定入口，供转播配置直接引用）；
4. 按 `keep` 裁剪旧成品（只保留最近 N 份带日期戳的文件）；
5. 全程走 `scripts/satellite.mjs` 的既有离线渲染路径。

### 8.3 配置项

```yaml
satellite:
  enabled: true
  auto: true     # 关闭后两条链路都不再触发（cordis 侧直接禁用，脚本侧仍可手动跑）
  hour: 3        # 墙钟触发小时（0..23）
  keep: 7        # 保留最近 N 份成品，超出裁剪
```

### 8.4 广播入口

生成完成后 cordis 侧 emit `satellite:generated`（载荷含输出文件路径），
供后续频道刷新 / 通知类插件订阅。

### 8.5 卡死防护（实测教训）

一次「每日任务」曾在 Windows 上挂起 **4.5 小时**既不产出也不退出，
进程锁被长期占用，两条调度链路同时失效。两个根因已修：

1. **瓦片请求无超时** —— GIBS 偶发「连上但不返回」。
   已为 capabilities 与每张瓦片的 `fetch` 加 `AbortSignal.timeout(20s)` 并重试。
2. **`fs.rmSync(dir, { recursive: true })` 在 Windows 上偶发永久挂起**
   （杀毒 / 索引器短暂持有刚写完的瓦片时，其内部同步重试循环卡住主线程）。
   已改为 `scripts/satellite.mjs` 中的 `removeDirSafe()`：显式
   `readdir → unlink → rmdir`，逐项 try/catch，失败只提示不中断
   （中间产物可重建，不值得让整条流水线停摆）。
   > 顺带修掉一处隐性 bug：收尾那行 `fs.rmSync('<dir>/tiles_*')` 用了通配符，
   > 而 `fs.rmSync` **不支持通配符**，实际是空操作，残留瓦片从未被清理。

兜底看门狗：`satellite-daily.mjs` 用 `spawn` + 定时器（默认 **25 分钟**，
可用环境变量 `SATELLITE_TIMEOUT_MIN` 覆盖），超时则 `taskkill /T /F` 杀掉整棵
进程树、释放 `.run.lock`、以 **124** 退出并留日志。最坏情况因此是有界的。
