# 📺📻 本地转播站（monorepo）

G:\tools\private-radio-stations —— 视频转播与音频电台的整合仓库（npm workspaces）。

```
private-radio-stations/
├─ packages/core/    公共包：loader（启动审计 + !!js）/ ffmpeg-args / 配置校验
├─ apps/video/       视频转播站（ffmpeg → MediaMTX：RTSP/HLS/WebRTC；IPTV 频道库；59 平台解析）
├─ apps/audio/       音频电台（Node 直发 MP3/HLS；多码率；全球电台浏览）
├─ start-video.bat / start-radio.bat / stop-*.bat
└─ docs/             合并方案 / 架构笔记 / 网络指南
```

## 快速开始
W+R
powershell

```bash
cd G:\tools\private-radio-stations
npm install --registry=https://registry.npmmirror.com
npm run video   # 视频面板 http://localhost:8100
npm run radio   # 电台面板 http://localhost:8000
```

或双击根目录 start-video.bat / start-radio.bat（停止用对应 stop-*.bat）。

## 端口约定

| 应用 | 面板 | 媒体 |
|------|------|------|
| video | 8100 | RTSP 8554 / HLS 8888 / WebRTC 8889 / RTMP 1935 / 控制 API 9997 |
| audio | 8000 | /stream、/stream/<k>、/hls/* |

## 文档

- apps/video/README.md — 视频转播站完整说明；
- apps/audio/README.md — 电台完整说明；
- apps/video/docs/ — 合并方案（MERGE_PLAN）、架构笔记（HARNESS_NOTES）、网络指南（NETWORK）。

## 许可

整体 MIT；apps/video/src/live/（real-url）为 GPL-2.0，见各自 LICENSE。
