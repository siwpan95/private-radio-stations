# 🎧 转播电台浏览器扩展（Edge / Chrome 通用）

一个 **Manifest V3** 浏览器扩展，把转播电台（Node.js + Cordis **3.0 版**）的控制装进浏览器工具栏。
同一套代码 **Edge 与 Chrome 通吃**（都是 Chromium 内核，MV3 完全一致），无需构建步骤（纯原生 JS）。

## ✨ 功能（对齐 3.0 API）

- **转播状态**：空闲 / 转播中 + 当前源名称与 URL（`/api/status` 的 `mode` / `current`）
- **一键转播 / 停止**：`POST /api/relay`（支持**多源 failover**：输入框逗号或换行分隔，第一个为主源，其余为 `fallbacks`）
- **★ 收藏到预设**：把当前源写入后端 `presets.json`（`POST /api/presets`）
- **健康信息**：源数量 / 失败次数 / 是否缺 ffmpeg；状态栏显示后端版本（`version` 字段）
- **图标徽标**：转播中显示 ♪ 徽章（service worker 每 5 秒轮询）
- **⚙️ 选项页**：配置服务器地址（保存后自动探测 `/api/status` 并显示在线版本）

## 📦 目录结构

```
extension/
  manifest.json     MV3 清单（host_permissions / popup / options / service_worker）
  popup.html        工具栏弹窗 UI
  popup.css         玻璃拟态样式
  popup.js          状态轮询 / 转播 / 停止 / 收藏（每 2 秒刷新）
  options.html      配置页
  options.css
  options.js        服务器地址读写 + 保存后连通性探测
  background.js     service worker（badge 集成，每 5 秒刷新）
  icons/
    icon-192.png
    icon-512.png
```

## 🚀 加载方式

### Edge（基于 Chromium，MV3 原生支持）

1. 打开 `edge://extensions/`
2. 右上角打开 **开发人员模式 / Developer mode**
3. 点 **加载解压缩的扩展 / Load unpacked**
4. 选择本仓 `apps/audio/extension/` 目录（含 `manifest.json` 的那一层）
5. 工具栏出现电台图标 → 点开即可用
6. 右键图标 → **选项 / Options** 配置服务器地址

### Chrome

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式 / Developer mode**
3. 点 **加载已解压的扩展程序 / Load unpacked**
4. 选择本仓 `apps/audio/extension/` 目录
5. 工具栏点扩展图标（如未固定，点拼图图标 🧩 固定到工具栏）
6. 右键图标 → **选项 / Options** 配置

> 二者步骤几乎完全一样，只是入口 URL 不同（`edge://extensions` vs `chrome://extensions`）。
> 扩展代码 **零修改** 即可在两个浏览器并存使用。

## ⚙️ 选项页配置

| 字段 | 默认 | 说明 |
|------|------|------|
| 服务器地址 | `http://localhost:8000` | 电台后端地址；公网穿透后改成公网 URL（ngrok/cloudflared 的 https 地址亦可） |

保存后自动探测一次 `/api/status`，成功会显示「服务器在线 v3.0.0」。

## 🔐 权限说明

`manifest.json` 声明的 `host_permissions`：

- `http://*/*` 与 `https://*/*` — 允许连接任意自建电台地址（本机 / 局域网 IP / 公网穿透域名）
- 只申请 `storage`（保存服务器地址），不请求 `tabs` / `history` / `cookies` 等敏感权限

## 🧪 验证

```bash
# JS 语法检查
node --check popup.js options.js background.js
# manifest JSON 合法性
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

加载后打开弹窗：显示「空闲」与版本号即连通；输入流地址点 ▶ 转播，标题切换为源名称、徽标变 ♪。

## 🛠️ 开发提示

- 改完代码到 `edge://extensions` 或 `chrome://extensions` 点扩展卡片上的 **刷新 ↻** 即可重载，无需重打包。
- `popup.js` 每 2 秒轮询 `/api/status`；后端 `web.js` 已对全部响应开放 CORS（`Access-Control-Allow-Origin: *`），扩展 popup 可跨域 fetch。