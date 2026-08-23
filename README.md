# 📺 本地视频转播站（Local Video Relay）— Node.js + Cordis + MediaMTX

把任意网络视频流（HLS/RTSP/RTMP/HTTP 直链）拉到本地，用 **MediaMTX** 分发成
RTSP / HLS / WebRTC 三种格式，局域网内任意设备（电脑、手机、电视）都能看。
架构参考 `D:\private-radio-stations-2.0`（Node.js + Cordis + yml 插件式加载），
电台版转音频 → 本版转视频。

> 定位：**本地观看**（家庭/个人）。带网页控制面板、预设频道、手动 URL、
> 备用源自动 failover、失败自动重试、边看边录像、OBS 推流入口。

---

## 🧩 架构（Cordis 插件）

`src/loader.js` 读取 `cordis.yml`，按声明顺序应用每个插件，然后发出 `ready`。

| 插件 | 职责 |
|------|------|
| `config`   | 端口 / 路径名 / MediaMTX·ffmpeg 位置 / 录像配置（启动时校验 yml）|
| `logfile`  | 文件日志 + 错误环（`data/logs/stream.log`）|
| `mediamtx` | 托管 MediaMTX 进程：启动 / 崩溃自动重启 / 控制 API 健康探测 |
| `station`  | 转播状态机（idle ↔ relay）+ 多源 failover + 原地重试 |
| `streamer` | ffmpeg 拉远端源 → 推 RTSP 给 MediaMTX（`-c copy` 或转码 H.264）|
| `recorder` | 录像：从本地 RTSP 拉流落盘 `recordings/*.ts` |
| `presets`  | `presets.json` 读写（去重 + 原子写）|
| `web`      | HTTP API + 控制面板（Node 内置 http，无框架）|

数据流：

```
远端视频源 ──ffmpeg 拉流──▶ rtsp://127.0.0.1:8554/live ──MediaMTX──▶ RTSP  :8554
（HLS/RTSP/…）    (-c copy/转码)                                   ├─▶ HLS   :8888
                                                                   └─▶ WebRTC :8889
```

## 🚀 快速开始

1. 确保 `mediamtx/mediamtx.exe`、`ffmpeg/ffmpeg.exe` 已就位（见下方「依赖」）。
2. 双击 `start-stream.bat`（自动装依赖并启动），或手动：

```bash
npm install --registry=https://registry.npmmirror.com
node src/index.js
```

3. 打开控制面板 http://localhost:8100/ ，点预设频道即开始转播。

## 📺 观看地址（转播中）

| 协议 | 地址 | 播放方式 |
|------|------|----------|
| RTSP | `rtsp://本机IP:8554/live` | VLC「打开网络串流」/ PotPlayer Ctrl+U / mpv |
| HLS | `http://本机IP:8888/live/index.m3u8` | 网页 / 手机播放器 |
| WebRTC | `http://本机IP:8889/live/` | 浏览器直接打开（低延迟）|

面板的「观看」区会自动显示这些地址，并提供网页内嵌预览。

## 🎥 OBS 推流模式（采集卡 / 摄像头 / 屏幕）

- OBS（本机已装 `F:\obs-studio`）→ 设置 → 推流：
  服务器 `rtmp://127.0.0.1:1935/obs`，串流密钥留空 → 开始推流。
- 观众看 `rtsp://本机IP:8554/obs` 或 `http://本机IP:8888/obs/index.m3u8`。
- 路径名**不要用 `live`**（与转播路径冲突，MediaMTX 同一路径只允许一个发布者）。

## 🔌 API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/` | 控制面板 |
| GET  | `/api/status` | 状态（模式/当前源/failover/ffmpeg/MediaMTX/录像/观看地址）|
| POST | `/api/relay` | 开始转播 `{"url","name?","fallbacks?":[],"transcode?":bool,"record?":bool}` |
| POST | `/api/relay/stop` | 停止转播 |
| POST | `/api/record` | 开/关录像 `{"on":bool}` |
| GET  | `/api/recordings` | 录像文件列表 |
| DELETE | `/api/recordings?name=…` | 删除录像 |
| GET  | `/recordings/<file>` | 下载录像 |
| GET/POST/DELETE | `/api/presets` | 预设频道读写（POST 传 `{name,url,desc?,icon?}`）|

## ⚙️ 配置（cordis.yml）

- `port: 8100` 面板端口；`pathName: live` 转播路径名。
- `transcode: false` 默认 `-c copy` 原码流；**H.265/AV1 源在网页看不了时**，
  在面板勾选「转码 H.264+AAC」，或把此值改 `true`（转码吃 CPU）。
- `record.enabled` 开始转播时默认是否录像（面板可随时开关）。
- `rtspPort/hlsPort/webrtcPort` 必须与 `mediamtx.yml` 的监听端口一致。

## 🧰 依赖

- **MediaMTX**：`mediamtx/mediamtx.exe`（v1.20.x Windows amd64）。
  GitHub 直连不通的机器可用镜像：
  `https://ghfast.top/https://github.com/bluenviron/mediamtx/releases/download/v1.20.1/mediamtx_v1.20.1_windows_amd64.zip`
  解压后把 `mediamtx.exe` 放进 `mediamtx/`，配置用本项目自带的 `mediamtx.yml`。
  校验：SHA256 `dc970f8e1f3ad58edafcf536bcd1ffe0adcb4390e7ace9377694a9ea2c1ebe53`。
- **ffmpeg**：`ffmpeg/ffmpeg.exe`（gyan.dev essentials 构建，当前为 2026-06-08 git 版，含 hls/rtsp/libx264）。
- **Node.js ≥ 22**（本机 v26 已验证）。

## 🌐 代码仓库

Gitee：https://gitee.com/siwpan/private-radio-stations/tree/video/（本项目在 `video` 分支，电台版在主分支）。

## 🛠️ 已知限制 / 踩坑

- 转播 HLS 直播源断流后 ffmpeg 会自己重连；**连续 3 次短命失败**才切换备用源 /
  停止重试，面板会显示错误原因。
- 点播源（如测试短片）播完会提示「源播放结束」，重新点开始即可。
- RTSP 拉源失败多是网络/鉴权问题，面板「ffmpeg 退出前日志」可查细节
  （完整日志在 `data/logs/stream.log`）。
- H.265 源转 RTSP/HLS 在部分浏览器不能放 → 勾选转码；转码码率写死在
  `src/plugins/streamer.js` 的 `buildArgs()` 里，需要可自行改。
- 换源/停止后，正在观看的播放器需要手动重连（协议特性）。
## 📁 目录布局

```
G:\tools\video\              ← 项目根（转播站本体）
  cordis.yml / mediamtx.yml / presets.json / package.json / start-stream.bat / README.md
  src\ plugins\              ← Node 插件（config/mediamtx/station/streamer/recorder/presets/web…）
  public\                     ← 控制面板静态页
  scripts\                    ← smoke.mjs（冒烟测试）、dl_mtx.py（MediaMTX 镜像下载）
  ffmpeg\ mediamtx\          ← 运行时二进制（mediamtx\ 内含 MoQ 自动证书）
  recordings\ data\          ← 录像与日志（运行时生成）
  downloads\
    archives\                 ← 下载的压缩包（源码包 / MediaMTX 包 / ffmpeg 7z 等）
    extracted\                ← 已解压的第三方项目树
    installers\               ← 安装器（OBS 等）
```

> 根目录的两个 mediamtx 压缩包（`mediamtx-release.zip` 与 `mediamtx_v1.20.1_windows_amd64.zip`）
> 内容完全相同（SHA256 一致），与 `mediamtx\mediamtx.exe` 也是同一版本，可只留一份。
