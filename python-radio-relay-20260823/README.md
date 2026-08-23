# 转播功能存档（relay-archive-20260823）

来源：`G:\music\musickit\radio`（Python 电台，曾并入 musickit 的版本）
剥离时间：2026-08-23
去向：转播能力已整体移交 `D:\private-radio-stations-2.0`（Node.js + Cordis 3.0 版，
对应 gitee `siwpan/private-radio-stations` 的 `3.0` 分支）。
本目录现位于统一归档区 `archived/python-radio-relay-20260823/`（同仓库 `archived` 分支）。

## 剥离内容

- 在线转播（relay）：任意 http(s) 音频流转播 + 多源 failover + 转码/直连双分支
- Radio-Browser.info 全球电台浏览搜索（directory.py）
- 精选电台预设（presets.py + presets.json）与收藏接口
- 浏览器扩展 extension/（以转播控制为核心的 MV3 扩展；替代品见 Node 项目同目录）
- 节目单 schedule 的 relay / stop_relay 动作（深夜转播 Nightwave 条目）

## 文件映射（存档 → 原位置 → 剥离方式）

| 存档文件 | 原位置 | 剥离方式 |
|----------|--------|----------|
| radio/directory.py | radio/radio/directory.py | 整个模块删除 |
| radio/presets.py | radio/radio/presets.py | 整个模块删除 |
| radio/broadcaster.py | radio/radio/broadcaster.py | 删除 _run_relay / _relay_passthrough |
| radio/streamer.py | radio/radio/streamer.py | 删除 relay_stream / _relay_transcoded / _relay_passthrough |
| radio/station.py | radio/radio/station.py | 删除 relay 状态与 set_relay/stop_relay 等 |
| radio/web.py | radio/radio/web.py | 删除 /api/relay /api/browse /api/presets /api/favorites 与 relay 分支 |
| radio/schedule.py | radio/radio/schedule.py | 删除 relay / stop_relay 动作分支 |
| radio/transcoder.py | radio/radio/transcoder.py | 删除 probe_remote_codec / http_open / peek_http_headers |
| radio/api_docs.py | radio/radio/api_docs.py | 删除转播/浏览/预设端点文档 |
| radio/templates/index.html | radio/radio/templates/index.html | 删除在线转播/精选电台/浏览 UI 与 JS |
| radio/config.py | radio/radio/config.py | 删除 ENABLE_RELAY / TRANSCODE_RELAY |
| presets.json | radio/presets.json | 删除 |
| schedule.json | radio/schedule.json | 删除深夜转播条目 |
| extension/ | radio/extension/ | 整个目录删除 |
| README.radio.md / CHANGELOG.md | radio/ | 更新（删除转播相关内容） |

## 恢复方法

如需在 Python 版恢复转播：把本目录对应文件拷回原位置（映射表见上），
并在 radio/radio/config.py 恢复 `ENABLE_RELAY = True` 与 `TRANSCODE_RELAY = True`。
注意 broadcast/streamer/station/web 的 relay 部分与剥离后代码的上下文可能有小出入，
建议以本目录全量文件为准逐段比对移植。
