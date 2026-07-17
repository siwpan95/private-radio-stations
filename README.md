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

---

## 🚀 快速开始

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 放歌：把歌曲丢进 music/ 目录（mp3/ogg/flac/wav）

# 3. 启动
python run.py
```

打开浏览器：

- 控制面板：<http://localhost:8000/>
- 直接收听：<http://localhost:8000/stream>（VLC 打开这个地址）

> 没装 `waitress` 也能跑，会退回 Flask 开发服务器；多听众并发建议装上。

---

## 🧩 项目结构

```
radio/
  __init__.py     包说明
  config.py       全局配置（端口 / 台名 / 比特率 / 功能开关）
  mp3info.py      MP3 帧头比特率嗅探（纯 Python）
  station.py      电台状态机：歌单管理 + 播放控制（线程安全）
  streamer.py     流生成器：歌单流 / 在线转播流 + ICY 元数据
  web.py          Flask 路由：控制面板 + 流媒体接口
  templates/
    index.html    Premium 控制面板 UI
run.py            启动入口（waitress / Flask 自动降级）
requirements.txt  依赖
music/            歌曲目录（放歌到这里）
presets.json      精选电台预设（可编辑：name / url / desc / icon）
expose.sh         外网穿透一键脚本（自动确认服务 + 选 ngrok / cloudflared，并把公网地址回写面板）
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

## 🛠️ 已知限制 / 后续可优化

- 每个听众独立读取音频文件（非共享广播缓冲），人数多时磁盘 IO 略高；
  可加一个共享环形缓冲升级为“真广播”。
- 暂停是“挂起连接”，客户端缓冲耗尽后会自然停；恢复了接着播。
- 转播模式下切换需要听众刷新 / 重连（因协议结构不同）。
- 麦克风直播源（`live.py` 思路，来自 `experiments/6.py`）需要本机 ffmpeg，默认未启用。
- `mms://` 直播地址是 legacy 协议，纯 Python 服务无法转播（需 ffmpeg 转封装）；ESP32 等嵌入式设备请选 **http(s) 的 MP3 直链**（浏览结果里带 `ESP32✓` 标）。
