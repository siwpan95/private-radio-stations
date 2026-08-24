---
name: relay-stations
description: Maintain the relay stations monorepo (G:/tools/private-radio-stations). Cordis-based video relay + radio station (npm workspaces).
agent_created: true
---

# 本地转播站 monorepo 维护（Cordis）

## 概述
npm workspaces：packages/core（loader/config-validate/ffmpeg-args/logfile/presets/station-base/web-base/invariants）+ apps/video（MediaMTX 视频转播）+ apps/audio（电台转播）。姊妹独立仓库：G:\tools\video 与 G:\tools\audio\private-radio-stations-2.0（本 monorepo 为 MERGE_PLAN 方案 B 的整合）。

## 常用命令
- npm run radio（:8000）/ npm run video（:8100）
- 门禁：npm run check / npm run test / npm run smoke（两应用脚本矩阵对称：start/dev/check/test/smoke）
- 依赖：cordis 4.0.0-rc.8 + schemastery ^3.18.0（显式依赖）+ @relay/core

## 关键约定
- cordis.yml 插件注册表 + loader 装配审计（fail-loud）+ ready 事件 + invariants
- real-url（GPL-2.0）必须隔离在 apps/video 内，不传染 packages/core
- 明确不做（用户拍板）：M5 面板合一、P6 Entry 行式配置、P7 patch 分层、P8 热重载、P9 设置服务

## 已知陷阱
- 媒体模型差异：视频=推送型（MediaMTX），音频=拉取型（Node http 直发）——不要尝试单进程共面板
- ffmpeg/mediamtx 二进制不入版本库
- docs/ 有 MERGE_PLAN / HARNESS_NOTES（借鉴 dsh 的装配纪律笔记），改动架构前先读