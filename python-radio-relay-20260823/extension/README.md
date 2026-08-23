# 🎧 Radio Browser Extension（Edge / Chrome 通用）

一个 **Manifest V3** 浏览器扩展，把你的 Python 电台控制面板装进浏览器工具栏。
同一套代码 **Edge 与 Chrome 通吃**（二者都是 Chromium 内核，MV3 完全一致），
无需分别打包、无需构建步骤（纯原生 JS）。

## ✨ 功能

- **正在播放**：封面、标题、歌手、专辑（来自 `/api/meta` + `/api/cover`）
- **🎤 歌词**：同步高亮滚动（本地 LRC 优先，缺失时走 LRCLIB 在线，零密钥）
- **🎛️ 控制**：播放 / 暂停 / 下一首（调 `/api/next` 等）
- **🔗 社群同步**：一键把当前曲发布到 Discord webhook / Telegram 频道
- **⚙️ 选项页**：配置服务器地址 + Discord/Telegram 凭据，存 `chrome.storage` 并同步到后端 `/api/integrations`
- **🎨 玻璃拟态 + 合成波** 风格，与控制面板视觉一致

## 📦 目录结构

```
extension/
  manifest.json     MV3 清单（host_permissions / popup / options / service_worker）
  popup.html        工具栏弹窗 UI
  popup.css         玻璃拟态 + 合成波样式
  popup.js          状态轮询 / 歌词同步 / 控制 / 发布
  options.html      配置页
  options.css
  options.js        凭据读写 + 同步后端
  background.js     service worker（badge 集成）
  icons/
    icon-192.png
    icon-512.png
```

## 🚀 加载方式

### Edge（基于 Chromium，MV3 原生支持）

1. 打开 `edge://extensions/`
2. 右上角打开 **开发人员模式 / Developer mode**
3. 点 **加载解压缩的扩展 / Load unpacked**
4. 选择 `G:\music\radio\extension\` 目录（含 `manifest.json` 的那一层）
5. 工具栏出现电台图标 → 点开即可用
6. 右键图标 → **选项 / Options** 配置服务器地址与凭据

### Chrome

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式 / Developer mode**
3. 点 **加载已解压的扩展程序 / Load unpacked**
4. 选择 `G:\music\radio\extension\` 目录
5. 工具栏点扩展图标（如未固定，点拼图图标 🧩 固定到工具栏）
6. 右键图标 → **选项 / Options** 配置

> 二者步骤几乎完全一样，只是入口 URL 不同（`edge://extensions` vs `chrome://extensions`）。
> 扩展代码 **零修改** 即可在两个浏览器并存使用。

## ⚙️ 选项页配置

| 字段 | 默认 | 说明 |
|------|------|------|
| 服务器地址 | `http://localhost:8000` | 电台后端地址；公网穿透后改成公网 URL |
| 启用社群同步 | 开 | 关闭后 announce 不发任何平台 |
| Discord Webhook | 空 | `https://discord.com/api/webhooks/...` |
| Telegram Bot Token | 空 | `123456:ABC-DEF...` |
| Telegram Chat ID | 空 | 频道/群组数字 ID |

保存后自动 `POST /api/integrations` 写入后端 `integrations.json`，弹出面板与控制面板共享同一配置。
**凭据只存在后端 `integrations.json`，GET 接口只返回布尔启用状态，不泄露密钥。**

## 🔐 权限说明

`manifest.json` 声明的 `host_permissions`：

- `http://localhost:8000/*` — 访问本地电台 API
- `https://lrclib.net/*` — 在线歌词查询（零密钥）
- `https://api.telegram.org/*` — Telegram Bot 发布（可选）
- `https://discord.com/api/webhooks/*` — Discord webhook 发布（可选）

权限按需最小化，不请求 `tabs` / `history` / `cookies` 等敏感权限。

## 🧪 验证

```bash
# JS 语法检查
node --check popup.js options.js background.js
# manifest JSON 合法性
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

加载后打开弹窗，应显示「正在播放」状态；点 ⚙️ 进入选项页填好服务器地址即可联动。

## 🛠️ 开发提示

- 改完代码到 `edge://extensions` 或 `chrome://extensions` 点扩展卡片上的 **刷新 ↻** 即可重载，无需重打包。
- `popup.js` 每 2 秒轮询 `/api/status`；歌词按 `elapsed` 同步高亮当前行并滚动居中。
- 后端需开启 CORS（`web.py` 的 `@app.after_request` 已对 `/api/*` 开放 `Access-Control-Allow-Origin: *`），扩展 popup 才能跨域 fetch。
