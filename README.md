# 📺📻 本地转播站（monorepo）

C:\private-radio-stations-master —— 视频转播与音频电台的整合仓库（npm workspaces，独立仓 siwpan/private-radio-stations）。
（上游本地副本曾位于 `G:\repos\private-radio-stations`、`D:\private-radio-stations-master`；本文档一律用当前副本路径。）

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
3. 候选探测：本仓 `external/pluginplayer/dist/pluginplayer.exe` → 源码仓 `C:\pluginplayer-main\dist\pluginplayer.exe`（取第一个存在的）。

```bash
python scripts/fetch-deps.py --features   # 从 Gitee 放 v1.0.0 发布物到 external/pluginplayer/dist
npm run link:player                       # 或：把源码仓构建产物同步进挂载点（整目录）
npm run link:player -- --dry              # 只报告将同步什么，不落盘
```

> ⚠️ `dist/` 必须**整目录**使用：exe 依赖同目录的 FFmpeg/SDL3/MinGW DLL 与 `plugins/`，只拷 exe 会启动失败。
> ⚠️ 不要在源码里写死盘符路径（`D:\`、`G:\`）——仓库换盘符就会静默断链；解析已一律改为相对本仓 + 候选探测。

## 快速开始

> 提示：按 `W+R` 输入 `powershell` 打开终端再执行下方命令——cmd 的 `cd` 不能跨盘符，PowerShell 无此问题。

```bash
cd G:\repos\private-radio-stations
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

> 本表与唯一事实源 `G:\docs\md\allin主工作区\端口分配表.md` 同步（2026-08-24 起，新服务先查表再选端口）。

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

> 本仓现行 master = 整合版（Node.js + Cordis 三簇：portal/video/audio + harness）；3.0 分支 = 转播版 Relay Only；2.0/archived* = 归档。本地对应 C:\private-radio-stations-master（上游曾位于 G:\repos\private-radio-stations）。
> 本标注为发布面统一追加，不改变原有内容。

---

## 编排 harness（离线黄金值门禁）

`npm run harness`（= node harness/harness.mjs）——组件清单 harness/manifest.json，契约 harness/spec.md：

- full-gate：scripts/check.mjs 全量门禁（语法 + cordis.yml + 包元数据 + 7 单测套件）→ 黄金值 exit 0
- fast-gate：--fast 快速门禁（pre-commit 同款）→ 黄金值 exit 0

JSON-lines 子进程协议 + ready 握手 + 逐请求超时；子进程由 port 层登记 effect，退出即 kill（无孤儿进程）；全绿 exit 0，任何分歧/报错 exit 1。无新增端口。在线端到端 smoke（需运行中服务 + ffmpeg + 网络测试源）仍由 npm run smoke:* 手动执行。
