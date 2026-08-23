# 视频转播站 × 音频电台 合并可行性报告

> 分析对象：`G:\tools\video`（本仓库）与 `G:\tools\audio\private-radio-stations-2.0`
> 两项目共享约 60% 框架骨架（loader/index/config/logfile/presets/station 高度同源），
> 但媒体数据流模型根本不同：
> - **视频** = 推送型：ffmpeg 拉源 → 推 RTSP 给 MediaMTX → 由 MediaMTX 分发，Node 不转发媒体字节；
> - **音频** = 拉取型：无 MediaMTX，web 插件用 Node http 直发 `/stream`、`/hls/*`，按客户端 spawn ffmpeg 转码。

## 结论

**主推方案 B（抽公共包 monorepo），第一步先落地方案 C（约定统一）。**
不建议一次性做方案 A（单进程共面板）：两套媒体模型差异大，硬合并会带来端口/状态/前端高耦合与高回归风险。

## 插件级复用度

| 模块 | 复用度 | 说明 |
|------|--------|------|
| loader.js | ≈100% | 两项目逐字节一致（视频版现已含启动审计 + `!!js`，直接作为公共模板）|
| index.js | ≈95% | 仅 shutdown 细节差异（视频先 stopRelay）|
| logfile.js | ≈100% | 仅日志文件名，配置化 `logfile.file` 即可 |
| presets.js | 视频为超集 | 视频 add 支持 desc/icon |
| streamer 头部 helpers | 100% | resolveSource / needsReconnect / RECONNECT_ARGS 完全一致 |
| config 校验器 | 骨架同 | 抽成「传入 schema 表」的通用校验器（音频版校验器更完善）|
| web HTTP 骨架 | 骨架同 | cors/json/readJson/serveFile/MIME/lanIP 一致，抽 web 基类 |
| station.js | 视频为超集 | transcode/record 标志 + noteEnded + error/startedAt |
| 视频独有 | — | mediamtx / recorder / channels / resolver / src\live（GPL-2.0）/ playlists |
| 音频独有 | — | hls 多码率切片 / browse / ICY 注入 / jingle 空闲音 / web-src(Vite) / test+check 门禁 / MV3 扩展 |

## 合并方案

### 方案 A：单仓库双模式共面板
一个进程一个面板，`mode: video|audio|both` 决定插件集。改动大、风险高、收益是运维最简单。**暂不推荐。**

### 方案 B：抽公共包 monorepo（推荐）
`packages/core`（loader/config-validator/logfile/presets/station-base/web-base/ffmpeg-helpers）+ `apps/video` + `apps/audio`。
改动中、风险中；消除重复、单点维护，两个应用仍独立启动/部署。
注意：real-url（GPL-2.0）必须隔离在 apps/video 内，避免传染公共包。

### 方案 C：仅共享约定与工具（零风险第一步）
两个仓库保持独立，仅统一插件命名/目录、cordis.yml 格式、API 命名、日志格式、
共用 loader 模板与 start/stop bat 模板。

## 推荐里程碑（每步可独立提交）

| 里程碑 | 内容 | 方案 |
|--------|------|------|
| M0 约定统一 | 插件命名/目录、loader.js 对齐、logfile 文件名配置化、/api/status 字段统一 | C |
| M1 抽共享 helper | ffmpeg-args / 通用 schema 校验器 抽为 lib 模块 | C |
| M2 monorepo 骨架 | workspaces + packages/core，两应用依赖 @relay/core | B |
| M3 基类扩展点 | station 基类 + 视频扩展；web 基类 + 各应用路由注册 | B |
| M4 工程化对齐 | 把音频的 test/check.mjs/git hooks/DEPLOY 推广到视频 | B |
| M5（可选）面板合一 | 统一面板分页签（仅当确定要一个面板管两种转播）| A |

## 附：音频项目顺手修正项

1. `start-radio.bat` 仍指向旧路径 `D:\private-radio-stations-2.0`，应改为 `G:\tools\audio\private-radio-stations-2.0`；
2. README 目录说明与实际不一致（`legacy-python/` → `archived/`）；
3. 视频版可反向吸收：音频的 test/ + check.mjs 门禁、DEPLOY.md 排障习惯。
