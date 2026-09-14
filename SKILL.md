---
name: relay-stations
description: Maintain the relay stations monorepo (C:\private-radio-stations-master; 上游曾位于 G:/tools、G:/repos、D:/private-radio-stations-master). Cordis-based video relay + radio station (npm workspaces).
agent_created: true
---

# 本地转播站 monorepo 维护（Cordis）

## 概述
npm workspaces：packages/core（loader/config-validate/ffmpeg-args/logfile/presets/station-base/web-base/invariants）+ apps/video（MediaMTX 视频转播）+ apps/audio（电台转播）。姊妹独立仓库：video 与 audio 的旧分仓（本 monorepo 为 MERGE_PLAN 方案 B 的整合）。

## 外部资产与联动（PluginPlayer）
播放器是独立仓 siwpan/pluginplayer，不在本仓；两个消费插件：
- `apps/video` 的 `launcher`（面板「快捷入口」，可见窗口，RPC 7921）
- `apps/audio` 的 `monitor`（面板「本机监听」，无窗口跟随转播，RPC 7911）

exe 解析（两侧同一套）：`config exe` > 环境变量 `PP_EXE` > **候选探测**：本仓 `external/pluginplayer/dist/pluginplayer.exe` → 源码仓 `C:\pluginplayer-main\dist\pluginplayer.exe`（取第一个存在的）。
- 投放：`python scripts/fetch-deps.py --features`（从 Gitee 拉**最新发行版** —— 运行时读 `/releases/latest` 的 302 解析 tag，再取 `SHA256SUMS.txt` 校验；发新版无需改脚本，`--force` 换版本）
  或 `npm run link:player`（同步源码仓 `build.py` 出的 dist，整目录）
- `external/` 是 .gitignore 的挂载点，不入库

## 常用命令
- npm run radio（:8000）/ npm run video（:8100）
- 门禁：npm run check / npm run test / npm run smoke（两应用脚本矩阵对称：start/dev/check/test/smoke）
- 依赖：cordis 4.0.0-rc.8 + schemastery ^3.18.0（显式依赖）+ @relay/core

## 关键约定
- cordis.yml 插件注册表 + loader 装配审计（fail-loud）+ ready 事件 + invariants
- real-url（GPL-2.0）必须隔离在 apps/video 内，不传染 packages/core
- 明确不做（用户拍板）：M5 面板合一、P6 Entry 行式配置、P9 设置服务
- 已落地：P7 patch 分层（`apps/*/cordis.patch.yml` 本机覆盖层，.gitignore 忽略，
  base cordis.yml 不改；`node scripts/dump-config.mjs <video|audio>` 看 base→patch 生效树）、
  P8 热重载（index.js `watch: true`，P8A patch 热重载，白名单键下一次动作生效）

## 已知陷阱
- 媒体模型差异：视频=推送型（MediaMTX），音频=拉取型（Node http 直发）——不要尝试单进程共面板
- ffmpeg/mediamtx 二进制不入版本库
- **不要在源码/配置里写死盘符路径**（曾出现 `D:\private-radio-stations-master\...`、
  `G:\local\pluginplayer\dist\pluginplayer.exe`）。仓库换盘符（G:→D:→C:）后它们全部静默失效，
  表现是 `[monitor]/[launcher] 播放器不存在: <死路径>`。外部资产路径一律「相对本仓 + 候选探测」。
- dist 必须整目录：`pluginplayer.exe` 依赖同目录的 FFmpeg/SDL3/MinGW DLL 与 `plugins/`
  （含 `manifest.sha256` 完整性清单，与 DLL 不匹配会被宿主拒载）
- docs/ 有 MERGE_PLAN / HARNESS_NOTES（借鉴 dsh 的装配纪律笔记），改动架构前先读