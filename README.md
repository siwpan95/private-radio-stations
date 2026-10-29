# 📺📻 本地转播站（monorepo）

## 仓库角色定位（投资组合分级 ②）

> 本仓在 siwpan 投资组合（D:/projects/repos，共 133 仓）中定级为 **② 保留**，领域 **音乐/音频**。
> **角色**：电台。
> **维护策略**：② 旗舰 / 枢纽仓库打磨保留，作为能力展示或收敛点；② 保留类仓库低优先维持、不主动扩张。
> 投资组合统一分级索引（多机可查）：[组合分级决策索引 · allin 事实源](https://gitee.com/siwpan/allin/blob/master/docs/事实源/组合分级决策索引.md)。

> 仓库：<https://gitee.com/siwpan/private-radio-stations> ｜ 许可：MIT（见 [LICENSE](LICENSE)）
> 注：文中 <PATH> 为路径占位符，请替换为你本机实际的目录 / 可执行文件路径。

<PATH> —— 视频转播与音频电台的整合仓库（npm workspaces，独立仓 siwpan/private-radio-stations）。
（上游本地副本曾位于 `<PATH>`、`<PATH>`；本文档一律用当前副本路径。）

```
private-radio-stations/
├─ packages/core/    公共包：loader（启动审计 + !!js + 热重载）/ ffmpeg-args / settings / invariants
├─ apps/portal/      统一门户 :9000（iframe 分页签嵌入两面板 + 聚合状态卡）
├─ apps/video/       视频转播站（ffmpeg → MediaMTX：RTSP/HLS/WebRTC；IPTV 频道库；59 平台解析）
├─ apps/audio/       音频电台（Node 直发 MP3/HLS；多码率；全球电台浏览）
├─ external/         仓库外资产挂载点（.gitignore 忽略，不入库）：
│                      pluginplayer/dist —— PluginPlayer 播放器本体（整目录）
├─ start/stop-{video,radio,portal}.bat
└─ docs/             合并方案 / 架构笔记 / 网络指南 / 配置规划 / 面板规划
```

## 外部资产：PluginPlayer（本机监听 / 快捷入口）

播放器是独立仓 siwpan/pluginplayer，**不属于本仓库**，由两个消费插件拉起：

| 消费方 | 插件 | 用途 | RPC 端口 |
|--------|------|------|----------|
| apps/video | `launcher` | 面板「快捷入口」，前台可见窗口 | 7921 |
| apps/audio | `monitor` | 面板「本机监听」，无窗口跟随转播 | 7911 |

exe 解析顺序（`apps/*/src/plugins/{launcher,monitor}.js`，两侧同一套实现）：

1. `cordis.patch.yml` 的 `exe` 配置；
2. 环境变量 `PP_EXE`；
3. 候选探测：本仓 `external/pluginplayer/dist/pluginplayer.exe` → 源码仓 `<PATH>`（取第一个存在的）。

```bash
python scripts/fetch-deps.py --features   # 从 Gitee 拉「最新发行版」到 external/pluginplayer/dist（运行时解析 tag，不写死版本）
npm run link:player                       # 或：把源码仓构建产物同步进挂载点（整目录）
npm run link:player -- --dry              # 只报告将同步什么，不落盘
```

> 💡 播放器版本**不在消费方写死**：`fetch-deps.py` 每次运行都去 Gitee 解析最新发行版
> （读 `/releases/latest` 的 302 拿 tag，再取同发行版 `SHA256SUMS.txt` 校验），
> 所以播放器发新版**不需要改本仓任何文件**。`--force` 可强制换成新版。

> ⚠️ `dist/` 必须**整目录**使用：exe 依赖同目录的 FFmpeg/SDL3/MinGW DLL 与 `plugins/`，只拷 exe 会启动失败。
> ⚠️ 不要在源码里写死盘符路径（`<PATH>`、`<PATH>`）——仓库换盘符就会静默断链；解析已一律改为相对本仓 + 候选探测。

## 快速开始

> 提示：按 `W+R` 输入 `powershell` 打开终端再执行下方命令——cmd 的 `cd` 不能跨盘符，PowerShell 无此问题。

```bash
cd <PATH>
npm install --registry=https://registry.npmmirror.com
npm run video   # 视频面板 http://localhost:8100
npm run radio   # 电台面板 http://localhost:8000
npm run portal  # 统一门户（9000 已不再常驻，见 allin-platform start-platform.bat 按需入口）
```

或双击根目录 start-video.bat / start-radio.bat / start-portal.bat（停止用对应 stop-*.bat）。

## 端口约定

| 应用 | 面板 | 媒体 |
|------|------|------|
| portal | 9000 | —（聚合门户）|
| video | 8100 | RTSP 8554 / HLS 8888 / WebRTC 8889 / RTMP 1935 / 控制 API 9997 |
| audio | 8000 | /stream、/stream/<k>、/hls/* |
| **localplayer-bridge** | **8787** | `/api/list`（给「轻量播放器」扩展用，见下节）|

> 本表与唯一事实源 `<PATH>` 同步（2026-08-24 起，新服务先查表再选端口）。

## 联动：把「轻量播放器」扩展当本项目的播放器

`scripts/localplayer-bridge.mjs` 是一个零依赖的聚合桥，把本项目的媒体源翻译成
[轻量播放器（Chrome / Edge 扩展）](https://gitee.com/siwpan/localplayer)认识的清单契约
`GET /api/list -> [{name, path, type}]`，于是浏览器扩展可以直接当本项目的音视频播放器用。

```bash
npm run bridge          # 或双击 start-bridge.bat
# 清单  http://127.0.0.1:8787/api/list
# 体检  http://127.0.0.1:8787/api/health
```

扩展侧无需任何改动（`plugins/radio-stations-source.js` 已内置，priority 15）；
只需保证两边端口一致，或在扩展的「选项 → 联动桥地址」里改。

### 聚合哪些源

| 源 id | 内容 | 依赖 |
|---|---|---|
| `audio.live` | 正在转播的电台（`/stream`，MP3） | audio 在线**且**正在转播 |
| `audio.hls` | 同一路电台的 HLS | 同上，且 `hls.enabled` |
| `audio.presets` | 电台预设（直接播放，无需转播） | audio 在线 |
| `video.hls` | MediaMTX HLS 直播 | MediaMTX 已收到推流 |
| `video.channels` | IPTV 频道库 | video 在线且有频道文件 |
| `video.recordings` | 录制回放 | video 在线 |

### 三条设计红线

1. **任一源挂了都不影响别人**：每个源独立超时（`LP_TIMEOUT_MS`，默认 1500ms）、
   独立 try/catch，挂了就只是不出现在清单里；全挂返回 `[]`，扩展自动回落到自己的本地媒体。
2. **只做播放，不做控制**：不调用 `/api/relay/start` 等写接口，启停转播仍在各自面板。
3. **只监听 127.0.0.1**，不往局域网暴露。

### 两个刻意的取舍

- **不列未转播的 `/stream`**：没在转播时那是一条静音占位流，列出来只会让人以为坏了。
  `/api/health` 里这种情况记为 `empty`（「当前没有」）而不是 `error`（故障）。
- **不列 `.ts` 录制**：Chromium 无原生 MPEG-TS 解码器。等对端录制改成 mp4/mkv 会自动出现。

### 排查

先看 `/api/health`：源状态三态 `ok` / `empty`（应答了但当前没内容）/ `error`（连不上或超时），
`error` 带原因。最常见的两类：

- 全是 `fetch failed` → audio / video 应用没起（`npm run radio` / `npm run video`）。
- `video.hls` 是 `MediaMTX 不可达` → MediaMTX 没起；若是 `empty` 则表示服务在但没在推流。

### 配置

均可用环境变量覆盖：`LP_BRIDGE_PORT`、`LP_AUDIO_BASE`、`LP_VIDEO_BASE`、`LP_MTX_BASE`、
`LP_MTX_PATH`、`LP_MAX_CHANNELS`、`LP_MAX_PRESETS`、`LP_TIMEOUT_MS`。

测试（起假上游验证聚合与降级，无需任何真实服务在线）：

```bash
node --test scripts/localplayer-bridge.test.mjs   # 也包含在 npm test 里
```

## 卫星影像（NASA GIBS · 离线渲染）

卫星影像走的是「**离线渲染 → 点播转播**」路线，不是直播频道：

- **数据源**：NASA GIBS（公有领域，免费免注册）。GIBS 只提供静态瓦片，**没有现成视频流**，
  必须先用 ffmpeg 离线渲染成 mp4。
- **为什么不能做直播**：本机无可用硬件编码（nvenc/qsv/amf 实测全失败），软件编码速度仅
  0.03x~0.30x，**无法实时**，故渲染成 mp4 后当作点播源转播（复用既有的 `-c copy` 路径，无需改 streamer.js）。

### 触发方式

| 触发 | 入口 | 说明 |
|---|---|---|
| 面板手动 | 视频面板「🛰️ 卫星影像」卡片 → **立即生成一次** | `POST /api/satellite/generate`：派生 `scripts/satellite-daily.mjs`（detached + unref，返回 202），由它再拉起渲染脚本 `scripts/satellite.mjs` 抓取 GIBS 瓦片、合成 mp4 |
| 面板查询 | `GET /api/satellite` | 列举成品目录（`apps/video/satellite/`）里的 `satellite-YYYY-MM-DD.mp4` 与最新 `satellite.mp4` |
| 每日自动 | 每日 03:00（墙钟） | cordis `satelliteScheduler` 服务（`cordis.yml` 里 `satellite.hour=3`）+ **WorkBuddy 自动化**双冗余，二者共用同一条 `scripts/satellite-daily.mjs` |

`satellite-daily.mjs` 内部有**进程锁**（`apps/video/satellite/.run.lock` 记录 PID + 存活判定），
所以即便调度服务与 WorkBuddy 自动化同时触发，也只真正跑一次；生成完成会把最新一份复制为
`satellite.mp4` 作为稳定入口，并裁剪超过 `keep`（默认 7）份的旧档。

### 配置

集中在 `apps/video/cordis.yml` 的 `config → satellite` 段：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否启用整条链路 |
| `dir` | `satellite` | 成品目录（相对 `apps/video`）|
| `source` | `modis` | 图层源：`modis` / `viirs` / `weld` |
| `zoom` | `3` | 0..9，越大越清晰、越耗流量 |
| `days` | `5` | 多日合成，减轻 MODIS 条带缝隙 |
| `auto` | `true` | 是否启用每日自动生成 |
| `hour` | `3` | 墙钟触发小时；进程在触发点之后启动则 5 分钟后补跑一次 |
| `keep` | `7` | 保留最近 N 份成品 |

命令：`npm run satellite -- --days 5`（更多用法见 `scripts/satellite.mjs` 头部注释，含 `--list` / `--source` / `--zoom` / `--keep-tiles` 等）。

### ⚠️ 实测限制：卫星源当前拉不动

本机实测：**GIBS 瓦片抓取不通，卫星影像拉不动**。连续 3 次拉流失败后，转播 `station` 状态机
已**停止自动重试**，面板提示「检查源地址或网络后点『开始转播』/『立即生成』重试」。

> 注意：这条「连续 3 次短命失败才停止重试」的提示与文案，是**转播 station 状态机既有行为**
> （见 `apps/video/README.md`「已知限制」），并非卫星脚本本身抛出的错误——它只是如实反映了
> 「源拉不动」这一事实。根因是 GIBS 瓦片抓取/网络不通，不是代码逻辑 bug。
>
> 排查方向：确认本机能否直连 GIBS 瓦片服务（`gibs.earthdata.nasa.gov`），或源地址/代理是否变化；
> 网络恢复后，手动点面板「立即生成一次」或「开始转播」即可重试。

## 开发与门禁

```bash
npm run check          # 全量门禁：全仓语法 + yml/manifest + 43 项单测（pre-push 自动执行）
npm test               # 全部单测
npm run check:video / test:video / check:radio / test:radio   # 单应用
npm run smoke:video / smoke:radio          # 端到端冒烟（需对应服务在跑）
node scripts/dump-config.mjs <video|audio>  # 打印生效配置树（base+patch）
npm run link:player                         # 同步 PluginPlayer 源码仓构建产物到 external/
node scripts/update-playlists.mjs           # 镜像链更新 IPTV 频道列表
```

git hooks（`npm install` 自动安装）：pre-commit = 快速门禁（语法+yml+空白），pre-push = 全量门禁。

## 文档

- apps/video/README.md — 视频转播站完整说明；
- apps/audio/README.md — 电台完整说明；
- docs/ — 合并方案（MERGE_PLAN）、架构笔记（HARNESS_NOTES）、网络指南（NETWORK）、配置体系规划（ROADMAP_CONFIG）、面板规划（ROADMAP_PANEL）。

## 许可

整体 MIT；apps/video/src/live/（real-url）为 GPL-2.0，见各自 LICENSE。


---

## 仓库索引标注（2026-08-27 · siwpan 统一治理）

> 本仓现行 master = 整合版（Node.js + Cordis 三簇：portal/video/audio + harness）；3.0 分支 = 转播版 Relay Only；2.0/archived* = 归档。本地对应 <PATH>（上游曾位于 <PATH>）。
> 本标注为发布面统一追加，不改变原有内容。

---

## 编排 harness（离线黄金值门禁）

`npm run harness`（= node harness/harness.mjs）——组件清单 harness/manifest.json，契约 harness/spec.md：

- full-gate：scripts/check.mjs 全量门禁（语法 + cordis.yml + 包元数据 + 7 单测套件）→ 黄金值 exit 0
- fast-gate：--fast 快速门禁（pre-commit 同款）→ 黄金值 exit 0

JSON-lines 子进程协议 + ready 握手 + 逐请求超时；子进程由 port 层登记 effect，退出即 kill（无孤儿进程）；全绿 exit 0，任何分歧/报错 exit 1。无新增端口。在线端到端 smoke（需运行中服务 + ffmpeg + 网络测试源）仍由 npm run smoke:* 手动执行。
