# 📻 我的电台 · 转播版（Relay Only）— Node.js + Cordis

一个用 **Node.js + [Cordis](https://cordis.js.org) 插件框架** 实现的轻量级**转播电台**：把任意网络电台（预设 / 手动输入 / 浏览发现 / 备用源 failover）转播出去，任意设备都能收听。

> 本版本**只做转播**：本地歌单、录音、歌词、社群同步、PWA、上传、排程、鉴权等功能**已全部移除**（Python 旧版已归档到 `legacy-python/`）。
> 转播对象不限于全球电台——可以手动输入任意 `http(s)` 音频流 URL，甚至手动增加备用源。

技术栈从 Python/Flask 整体迁移到 **Node.js + Cordis**（参考 `G:\notpython\deepseek-harness-master` 的 Cordis + yml 部署形态）。`cordis-main.zip` / `paper-main.zip` 为参考源码，已解压归档在 `vendor/cordis/`（运行时走 npm 安装的 `cordis`，不依赖该目录）。

---

## ✨ 功能（仅转播）

- 🌐 **在线转播（relay）**：把别的网络电台转播进来，随时停止
  - 预设电台（`presets.json`）一键转播
  - 手动输入任意 `http(s)` 音频流 URL 转播
  - **手动增加备用源**：主源连不上自动 failover 到下一个（逗号分隔，最多 3 次失败切换）
- ⭐ **精选电台预设**：`presets.json` 直连流，点一下即转播；浏览结果里点 **★ 收藏** 可一键写入 `presets.json`（刷新生效）
- 🌍 **浏览全球网络电台**：搜索 Radio-Browser.info 数万真实电台，一键转播；每条带**直链复制**
- 💿 **实时可视化**：音频驱动的中心旋转唱片 + 放射状频谱（Web Audio `AnalyserNode`）
- 🎛️ **控制面板**：看「正在转播」+ 切换源 + 收藏，明暗主题
- 📺 **HLS 切片输出（双码率 ABR）**：一个 ffmpeg 进程同时切出 128k/64k 两档 AAC，`hls/live.m3u8` 为 master 播放列表（播放器按网速自适应），供网页/手机低延迟播放
- 🎚️ **多码率挂载点**：额外 `/stream/64`、`/stream/320`（ffmpeg 实时转码，手机省流量 / WiFi 高音质）
- 🏷️ **ICY 元数据**：播放器（VLC/Winamp 等）请求带 `Icy-MetaData: 1` 时，主串流每 8192 字节插入「正在转播」标题
- 🔔 **空闲台标音**：未转播时打开 `/stream` 循环播放 `jingle.mp3`（代替 409 报错）
- 🔴 **公网收听**：`start-radio.bat` 可一键拉起（含本地 npm 镜像代理），面板显示分享地址

---

## 🧩 架构（Cordis 插件）

`src/loader.js` 读取 `cordis.yml`，按声明顺序把每个插件 `ctx.plugin(...)` 应用，然后手写 `await tick; ctx.emit('ready')` 驱动生命周期（该版本 Cordis 无 `ctx.start()`，插件为异步应用，需 `static inject` 声明依赖服务）。

| 插件 | 职责 | 注入服务 |
|------|------|----------|
| `config`   | 解析端口 / 路径 / ffmpeg 二进制 / HLS·挂载点配置 | — |
| `station`  | 转播状态机（idle ↔ relay）+ 多源 failover | config |
| `streamer` | 通过 ffmpeg 拉流并做多码率转码挂载；无 ffmpeg 时回退 Node fetch 代理 | config, station |
| `hls`      | 由 station 生命周期驱动的 HLS 切片（ffmpeg） | config, station |
| `browse`   | Radio-Browser.info 全球电台搜索 | — |
| `presets`  | `presets.json` 读写（去重 + 原子写） | config |
| `web`      | Node 内置 `http` 的 API + 控制面板 UI | config, station, streamer, hls, browse, presets |

**关键设计**：ffmpeg 用自身的 `-reconnect` 网络栈去拉源（绕过 Node `fetch` 在本机网络下的不稳定），Node 只负责把字节流通过 HTTP 写回客户端。这与 HLS / 多码率挂载点共用同一条健壮路径。

---

## 🚀 快速开始

```bash
# 1. 安装依赖（本机 Node undici 拉大包会 EIDLETIMEOUT，见下方“部署”）
npm install
#   若 npm install 卡住，先起本地镜像代理再装：
#   python npm_local_mirror.py :8899 &   # 然后：
#   npm_config_registry=http://127.0.0.1:8899 npm install

# 2. （可选）放 ffmpeg：让 HLS / 多码率可用
#    把 ffmpeg.exe 放进项目根 ffmpeg/ 目录（ffmpeg/ 已 gitignore，不进版本库）
#    要求构建包含 http/https/hls 协议（gyan.dev essentials 已验证可用）
#    注意：F:\ffmpeg-8.1.2 与 F:\ffmpeg-9.0.1 是**源码树**，不是可执行二进制

# 3. 启动
node src/index.js
```

打开浏览器：

- 控制面板：<http://localhost:8000/>
- 直接收听：<http://localhost:8000/stream>（VLC 打开这个地址）
- HLS 低延迟：<http://localhost:8000/hls/live.m3u8>

> 一键部署（Windows）：`python gen_start_bat.py` 生成 `start-radio.bat`，双击即拉起镜像代理 + 安装依赖 + 启动服务。

---

## 🔌 API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/`              | 控制面板网页 |
| GET  | `/stream`        | 主音频流（默认 128k；空闲循环台标音；带 `Icy-MetaData: 1` 时插入标题元数据）|
| GET  | `/stream/<k>`    | 多码率挂载点，`k` ∈ {64, 320}（ffmpeg 转码）|
| GET  | `/hls/<file>`    | HLS 分片（`live.m3u8` master + `v_128k/v_64k.m3u8` 变体 + `*.ts`，仅转播中有效，空闲 404）|
| GET  | `/api/status`    | 当前状态 JSON（含 `version` / `hls_variants` / `ffmpeg`） |
| POST | `/api/relay`     | 开始转播 `{"url","name?","fallbacks?":[...]}` |
| POST | `/api/relay/stop`| 停止转播 |
| GET  | `/api/browse`    | 搜索全球电台 `?q=关键词&limit=20` |
| POST | `/api/presets`   | 把电台写入 `presets.json`（去重 + 原子写）|
| DELETE | `/api/presets`  | 删除预设 `?url=...` |

---

## 🛠️ ffmpeg 相关注意事项（踩坑记录）

- **`-reconnect` 是 http/https/rtmp 等网络协议的选项**，ffmpeg 对**本地文件输入**会直接报 `Option reconnect not found` 并退出。因此代码里 `needsReconnect(url)` 只对网络 URL 加 `-reconnect` 系列参数，本地文件不加。
- **播放列表解析**：`streamer.resolveSource()` 对 `.m3u/.m3u8/.pls` 输入会抓取文本、提取第一条 `http(s)` 直链再交给 ffmpeg（best-effort，失败则回退原 URL）。
- **二进制要求**：必须用含 `http`/`https`/`hls` 协议的 ffmpeg 构建；缺这些协议时 HLS / 多码率 / 网络转播全部不可用，但本地文件直转仍可由 Node fetch 回退勉强工作。
- ffmpeg 子进程随客户端断开（`req` close）被 `SIGKILL` 回收，避免泄漏。

---

## 🧩 浏览器扩展（Edge / Chrome）

`extension/` 是 Manifest V3 扩展（v3.0.0，对齐 3.0 API），弹窗里看转播状态 + 一键转播 / 停止 / 收藏（支持多源 failover）+ ♪ 徽标：
- **Edge**：`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选 `extension/`
- **Chrome**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`

加载后点 ⚙ 填服务器地址（默认 `http://localhost:8000`，保存时自动探测服务器在线版本）。

---

## 🌍 让外网也能收听

默认只在局域网。要让互联网上的人也能听：

1. **有公网 IP**：路由器端口转发 `8000 -> 8000`，听众用 `http://你的公网IP:8000/stream`。
2. **无公网 IP**：用 `start-radio.bat` 或自行 `cloudflared` / `ngrok` 穿透。
3. 把 `/stream` 地址（或 HLS 地址）发给朋友即可。

---

## 📦 项目结构

```
private-radio-stations-2.0/
  src/
    index.js         启动入口（new Context → loader → 监听 SIGINT/SIGTERM）
    loader.js        读取 cordis.yml 驱动插件加载 + ready 事件
    plugins/
      config.js      全局配置（端口 / ffmpeg / HLS / 多码率）
      station.js     转播状态机 + 多源 failover
      streamer.js    流生成（ffmpeg 多码率转码 + fetch 回退 + 播放列表解析）
      hls.js         HLS 切片管理（ffmpeg 随转播启停）
      browse.js      Radio-Browser.info 搜索
      presets.js     presets.json 读写
      web.js         Node http 路由：控制面板 + 流媒体接口 + API
  cordis.yml         插件注册表 & 配置（yml 驱动）
  public/index.html  转播控制面板 UI（单文件）
  presets.json       精选电台预设（可编辑）
  ffmpeg/            ffmpeg 二进制（自选放，gitignore）
  hls/               HLS 切片产物（运行时生成，gitignore）
  extension/         MV3 浏览器扩展
  npm_local_mirror.py 本地 npm 镜像代理（修复本机 undici EIDLETIMEOUT）
  gen_start_bat.py   生成 start-radio.bat
  start-radio.bat    一键部署脚本（CRLF/ASCII）
  vendor/cordis/     cordis-main.zip 解压的 Cordis 源码（归档参考，运行期不依赖）
  legacy-python/     Python 旧版（已归档，仅供对照）
```

> `music/`、`recordings/`、`integrations.json` 等为旧版本残留，可忽略或删除；`jingle.mp3` 现在用于空闲态 /stream 的台标音循环，请保留。

---

## 🛠️ 已知限制

- 转播模式下切换需要听众刷新 / 重连（协议结构不同）。
- `mms://` 等 legacy 协议 ffmpeg 未必支持；嵌入式设备请选 **http(s) 的 MP3/AAC 直链**。
- HLS / 多码率依赖 ffmpeg；未安装时这部分不可用，但主 `/stream` 在有网络源时仍可经 Node fetch 回退（稳定性弱于 ffmpeg）。
- 每个听众独立读取远程流；人数多时建议多实例或前端用 HLS 单源分发。
