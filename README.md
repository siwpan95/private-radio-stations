# 📻 我的Python电台

一个用 **纯 Python + Flask** 搭建的轻量级网络电台。把本地歌曲变成一条
24/7 的音频流，任何设备（手机 / 电脑 / 播放器）都能收听，还能在网页上
实时控制播放、看 “正在播放”、甚至转播别的网络电台。

> 设计取舍：相比 Icecast + libshout 或 Cycast（需要 Cython 编译 / 独立服务），
> 本方案**零外部服务、纯 Python 即可运行**，一个人也能轻松维护和二次开发。
> 代价是并发能力靠 WSGI 服务器（waitress）支撑，适合个人 / 小圈子电台。

---

## ✨ 功能

- 🎵 **本地歌单流**：自动扫描 `music/` 目录，循环播放（支持 mp3/ogg/flac/wav）
- 🏷️ **ICY 元数据**：播放器（VLC / Winamp / PotPlayer）能显示 “正在播放”
- 🎛️ **Premium 控制面板**：玻璃拟态 + vaporwave 渐变 + 合成波网格 + 辉光微交互（明暗主题）
- 💿 **实时可视化**：音频驱动的中心旋转唱片 + 放射状频谱（Web Audio `AnalyserNode`，本地/转播都生效）
- ⭐ **精选电台预设**：Nightwave Plaza、Groove Salad 等直连流，一键转播（改 `presets.json` 即可增删，刷新页面生效）；转播中或浏览结果里点 **★ 收藏** 可一键写入 `presets.json`
- 🌐 **在线转播（relay）**：把别的网络电台转播进来，随时切回本地歌单
- 🌍 **浏览全球网络电台**：搜索 Radio-Browser.info 数万真实电台，一键转播；每条带**直链复制**与 **ESP32✓** 标识（MP3/http 流），可勾选“只看 MP3”方便 ESP32 取直链
- 🌗 **明暗主题**：控制面板跟随系统并记忆偏好
- ⚡ **节奏自适应**：按文件比特率（MP3 帧头嗅探）控制推流速度，客户端不卡顿
- 🔁 **转码固定 MP3（B1）**：转播 AAC/OGG 等非 MP3 流时自动经 ffmpeg 转成固定码率 MP3，浏览器 / 老客户端 / ESP32 都能播（从根因解决“无声”）
- 🎚️ **多码率挂载点（B3）**：`/stream/64`、`/stream/320` 额外挂载点，手机省流量 / WiFi 高音质
- 🔔 **开场台标音（B4）**：新听众连入先放一段 jingle，可替换 `jingle.mp3`（文件不存在则跳过）
- 🔴 **边播边录（B2）**：一键把当前广播录成干净 MP3 存到 `recordings/`（可做回听）；录音时主串流自动切固定 MP3 以保证录制文件干净
- 🏷️ **本地标签 + 内嵌封面（C1）**：自动读取 ID3/FLAC/M4A/OGG 的标题/歌手/专辑，抽出 APIC 内嵌封面显示在「正在播放」（纯 mutagen，离线）
- 📱 **PWA 可安装（C4）**：`manifest.webmanifest` + service worker + 图标，可「添加到主屏幕」当 App 用，离线也能打开壳
- 🎙️ **播客 RSS（C5）**：`/rss` 把 `recordings/` 里的录音作为播客订阅源发出去，播客 App 可订阅回听
- 🎤 **歌词显示（C2）**：本地同名 `.lrc` 优先（离线），缺失时走 LRCLIB 在线查询（零密钥）；面板/扩展里按播放进度同步高亮滚动
- 🔗 **社群同步（C3）**：当前曲一键发布到 Discord webhook / Telegram 频道；凭据存 `integrations.json`，GET 接口只返回布尔状态不泄露密钥
- 🧩 **浏览器扩展（Edge/Chrome）**：MV3 扩展把控制面板装进工具栏，正在播放 + 歌词同步 + 控制 + 社群发布，见 [`extension/README.md`](extension/README.md)

---

## 🚀 快速开始

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 放歌：把歌曲丢进 music/ 目录（mp3/ogg/flac/wav）

# 3. 启动
python G:\radio\run.py                # 只起本地服务
python G:\radio\run.py --expose       # 起服务 + 自动 cloudflared 公网穿透（trycloudflare 临时域名）
python G:\radio\run.py --expose ngrok # 同上但用 ngrok（failover 备选）
```

打开浏览器：

- 控制面板：<http://localhost:8000/>
- 直接收听：<http://localhost:8000/stream>（VLC 打开这个地址）

> `--expose` 会自动启动 cloudflared quick tunnel，公网地址写回面板（面板自动显示可复制分享）。
> Ctrl+C 停止时自动清理穿透子进程。高级用法（named tunnel 自定义域名 / 多隧道 failover / 守护重启）仍用 `bash expose.sh`。
> 没装 `waitress` 也能跑，会退回 Flask 开发服务器；多听众并发建议装上。

---

## 🧩 项目结构

```
radio/
  __init__.py     包说明
  config.py       全局配置（端口 / 台名 / 比特率 / 功能开关）
  mp3info.py      MP3 帧头比特率嗅探（纯 Python）
  station.py      电台状态机：歌单管理 + 播放控制（线程安全）
  streamer.py     流生成器：歌单流 / 在线转播流 + ICY 元数据 + 多码率 / 录音
  transcoder.py   ffmpeg 转码基础设施（B 层：转码 / 挂载点 / jingle / 录音）
  metadata.py     本地标签 + 内嵌封面读取（C1，纯 mutagen）
  lyrics.py       歌词双源：本地 LRC + LRCLIB 在线（C2，零密钥）
  integrations.py Discord/Telegram 社群同步（C3，后台线程发布）
  pwa/            PWA 资源：manifest.webmanifest / sw.js / icon-*.png（C4）
  web.py          Flask 路由：控制面板 + 流媒体接口 + C 层 API
  templates/
    index.html    Premium 控制面板 UI
run.py            启动入口（waitress / Flask 自动降级）
requirements.txt  依赖
music/            歌曲目录（放歌到这里）
presets.json      精选电台预设（可编辑：name / url / desc / icon）
integrations.json 社群同步凭据（C3：discord_webhook / telegram_token / telegram_chat_id / enabled）
expose.sh         外网穿透一键脚本（自动确认服务 + 选 ngrok / cloudflared，并把公网地址回写面板）
jingle.mp3        开场台标音（占位音，可替换成你自己的；文件删除则跳过）
recordings/       录音输出目录（B2 边播边录；C5 播客 RSS 源）
extension/        Edge/Chrome MV3 浏览器扩展（popup + options + background，见 extension/README.md）
experiments/      原始的 9 份探索稿（1.py~9.txt）备份，记录演进思路
```

> `experiments/` 里是整合前的零散尝试：
> `1.py` Icecast+libshout 推流 · `2.py` FFmpeg 推流 · `3/8.py` 控制 API ·
> `4/5.py` Flask 歌单流 · `6.py` 麦克风直播 · `7.py` ICY 头 · `9.txt` 本地+网络电台调研。
> 现在它们都被收敛进上面这套统一程序里了。

---

## 🔌 API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/`              | 控制面板网页 |
| GET  | `/stream`        | 音频流（支持 `Icy-MetaData: 1` 元数据）|
| GET  | `/api/status`    | 当前状态 JSON |
| POST | `/api/next`      | 下一首 |
| POST | `/api/pause`     | 暂停 / 继续 |
| POST | `/api/shuffle`   | 切换随机播放 |
| POST | `/api/rescan`    | 重新扫描歌单 |
| POST | `/api/relay`     | 开始转播 `{"url":"...","name":"..."}`（name 可选，用于 ICY 显示）|
| POST | `/api/relay/stop`| 停止转播 |
| GET  | `/api/browse`    | 搜索全球电台 `?q=关键词&limit=20`（Radio-Browser.info）|
| GET  | `/stream/<k>`    | 多码率挂载点，`k` ∈ {64, 320}（转码到该码率 MP3）|
| POST | `/api/record`    | 录音开关 `{"action":"start"｜"stop"}`（开启后广播录成 MP3）|
| GET  | `/api/meta`      | 当前/指定本地曲目标签 `?path=`（C1，title/artist/album）|
| GET  | `/api/cover`     | 当前/指定本地曲目内嵌封面图片 `?path=`（C1，无则 404）|
| GET  | `/api/lyrics`    | 歌词 `?path=`（C2，本地 LRC 优先 → LRCLIB 在线；返回 lines/plain/source/synced）|
| GET/POST | `/api/integrations` | 社群同步配置（C3，GET 只返回布尔启用状态，POST 写 integrations.json）|
| POST | `/api/announce`  | 立即把当前曲发布到 Discord/Telegram（C3，无凭据不报错）|
| GET  | `/rss`           | 播客 RSS 2.0（C5，基于 recordings/*.mp3）|
| GET  | `/recordings/<name>` | 录音文件下载（C5，防目录穿越）|
| GET  | `/manifest.webmanifest` `/sw.js` `/icon-*.png` | PWA 资源（C4）|

---

## 🌍 让外网也能收听

默认只在局域网。要让互联网上的人也能听，二选一（Python 程序不用改）：

1. **有公网 IP**：路由器端口转发 `8000 -> 8000`，听众用
   `http://你的公网IP:8000/stream`。
2. **无公网 IP**：用内网穿透，一行命令搞定：
   ```bash
   ngrok http 8000          # 生成公网 URL
   # 或 Cloudflare Tunnel（更稳定、可自定义域名）
   ```
3. **一键脚本**：`bash expose.sh` 自动确认电台服务在跑（没跑就启动），再自动选 `ngrok` / `cloudflared` 打通外网；两者都没装会给出安装指引。打通后把公网地址的 `/stream` 发给朋友即可收听。

需要更专业的能力（多频道、自动 DJ、节目单）可后续接入 Icecast / LiquidSoap。

---

## 🧩 浏览器扩展（Edge / Chrome）

`extension/` 目录是一个 **Manifest V3** 扩展，把控制面板装进浏览器工具栏：
正在播放（封面/标签）+ 歌词同步高亮 + 播放控制 + 一键发布到 Discord/Telegram。
**同一套代码 Edge 与 Chrome 通吃**（都是 Chromium 内核，MV3 完全一致），无需分别打包。

加载步骤（详见 [`extension/README.md`](extension/README.md)）：

- **Edge**：`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选 `extension/` 目录
- **Chrome**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/` 目录

加载后右键图标 → 选项，填服务器地址（默认 `http://localhost:8000`）+ Discord/Telegram 凭据即可。
后端已对 `/api/*` 开放 CORS（`Access-Control-Allow-Origin: *`），扩展 popup 可直接跨域 fetch。

---

## 🛠️ 已知限制 / 后续可优化

- 每个听众独立读取音频文件（非共享广播缓冲），人数多时磁盘 IO 略高；
  可加一个共享环形缓冲升级为“真广播”。
- 暂停是“挂起连接”，客户端缓冲耗尽后会自然停；恢复了接着播。
- 转播模式下切换需要听众刷新 / 重连（因协议结构不同）。
- 麦克风直播源（`live.py` 思路，来自 `experiments/6.py`）需要本机 ffmpeg，默认未启用。
- `mms://` 直播地址是 legacy 协议，纯 Python 服务无法转播（需 ffmpeg 转封装）；ESP32 等嵌入式设备请选 **http(s) 的 MP3 直链**（浏览结果里带 `ESP32✓` 标）。
