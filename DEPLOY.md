# 转播电台 · 部署说明与故障记录（DEPLOY）

> 借鉴 deepseek-harness 的 DEPLOY.md 格式：每次故障按「现象 → 根因（可复现证据）→ 修复」记录，
> 换机器 / 排障时按编号回查。

## 现状（v3.0.0）

- 启动方式：双击 `start-radio.bat`，或 `node src/index.js`（Node ≥ 22）
- 控制面板：http://localhost:8000/ ；主串流 `/stream`（含 ICY 元数据）
- HLS：`/hls/live.m3u8`（master，128k/64k 双码率 ABR）；挂载点 `/stream/64`、`/stream/320`
- 空闲态 `/stream` 循环播放 `jingle.mp3`（不再 409）
- 日志：`data/logs/radio.log`（自动截断 2MB，保留后半 1MB；最近 30 条错误在 `/api/status` 的 `recent_errors`）
- ffmpeg：项目自带 `ffmpeg/ffmpeg.exe`（gyan.dev essentials build；目录已 gitignore，需自行放置）

## 部署步骤（新机器）

1. 安装 Node ≥ 22（本项目用 `F:\node\node.exe`，可用环境变量 `NODE_EXE` 覆盖）
2. 双击 `start-radio.bat`（自动：拉起本地 npm 镜像代理 8899 → 等待就绪 → 装依赖 → 启动）
   - 或手动：`python npm_local_mirror.py` 然后 `npm install --registry=http://127.0.0.1:8899`
3. 放置 ffmpeg：把 `ffmpeg.exe` 与 `ffprobe.exe` 放入项目根 `ffmpeg/`（或确保 PATH 里有 ffmpeg）
4. 打开 http://localhost:8000/ 验证；`/api/status` 应返回 ffmpeg 为 true
5. 公网：ngrok（`NGROK_STATIC_DOMAIN` 静态域名）或 cloudflared/端口转发，把面板/串流地址分享出去

## 故障记录

### ① 镜像端口不一致（2026-08-23 修复）

- **现象**：双击 `start-radio.bat`，等待镜像代理 30 秒超时，走到「无代理直装」，
  在本机网络上 npm 卡死（undici EIDLETIMEOUT）。
- **根因**：`npm_local_mirror.py` 默认监听 `8899`（`NPM_PROXY_PORT`），
  而 `gen_start_bat.py` 生成 bat 时用 `PROXY_PORT=8898`，且未把端口传进环境变量——
  代理实际在 8899，bat 在等 8898。
- **修复**：`gen_start_bat.py` 的 `PROXY_PORT` 统一为 `8899`，bat 中显式
  `set NPM_PROXY_PORT=%PROXY_PORT%` 后再拉起代理；重新生成 `start-radio.bat`。
- **教训**：生成器与运行时脚本的端口常量必须单一来源。

### ② npm 大包拉取卡死（undici EIDLETIMEOUT）

- **现象**：`npm install` 拉 cordis/vite 等较大 tarball 时无输出挂起，最终 EIDLETIMEOUT。
- **根因**：本机网络的 Node undici 拉大包不稳（deepseek-harness 同款问题）。
- **修复**：本地 npm 镜像代理 `npm_local_mirror.py`（流式转发 + 磁盘缓存），
  `start-radio.bat` 走 `--registry=http://127.0.0.1:8899`。
- **注意**：装完记得把 `package-lock.json` 里的 `resolved` 从 `127.0.0.1:8899`
  归一化为 `https://registry.npmjs.org/`，否则其他机器 `npm install` 会去连本机。

### ③ F:\ffmpeg-8.1.2 / 9.0.1 是源码树，不能当二进制用

- **现象**：把 `F:\ffmpeg-8.1.2` 当 ffmpeg 目录 → 子进程启动即失败。
- **根因**：这两个目录是 configure/libavcodec/fftools 的**源码树**，不是构建产物。
- **修复**：`detectFfmpeg()` 排除这两个路径；项目自带 `ffmpeg/ffmpeg.exe`（essentials build）。

### ④ -reconnect 只属于网络协议

- **现象**：给本地文件输入加 `-reconnect` 参数，ffmpeg 报 Option reconnect not found 直接退出。
- **修复**：`needsReconnect(url)` 只对 http(s)/rtmp/rtsp/mms/srt/udp/tcp URL 追加 `RECONNECT_ARGS`。

### ⑤ 播放列表输入（.m3u/.m3u8/.pls）

- **现象**：部分电台给的是播放列表地址，ffmpeg 直连失败。
- **修复**：`streamer.resolveSource()` best-effort 抓取文本并取第一条 http(s) 直链；失败回退原 URL。

## 开发命令

```bash
node scripts/check.mjs      # 语法/manifest/yml/单测（pre-commit 自动跑）
npm test                    # node:test 单测（station/presets）
npm run smoke               # 端到端冒烟（起服务→curl 端点断言；需 ffmpeg 才全量）
npm run dev:web             # Vite 开发服务器（代理 /api 到 8000，改面板热更新）
npm run build:web           # 构建面板到 public/（postinstall 自动跑）
```
