# 面板演进规划：M5 面板合一 + 音频面板设置 UI（联网调研版）

> 状态：**调研完成，规划定稿，未实施**。调研日期 2026-08-24。

## 一、M5 面板合一（视频 + 音频统一入口）

### 调研结论（外部方案）

1. **微前端框架**（single-spa / qiankun 等）：适合大型多团队前端拆分，对两个 200 行级别的
   面板是明显过度设计（feature-sliced 社区共识：2025 年后 micro-frontends 仅在大团队有价值）——**不采用**。
2. **自托管聚合导航**（Homarr / Dashy / Heimdall）：解决「入口发现」而非「统一控制」，
   是链接跳转型仪表盘，不嵌控制能力——可作为门户的**形态参考**（卡片+状态徽章）。
3. **iframe 嵌入 + API 聚合**：最轻的统一方案——门户页 iframe 分页签嵌入两面板，
   顶部聚合两后端 /api/status 的健康卡片；无跨框架成本，各自面板独立演进。
4. **反向代理单域名**（nginx/caddy 子路径 /video /radio）：与 iframe 方案互补，
   解决「一个域名」问题，不解决「一个界面」问题。

### 候选架构对比

| 方案 | 形态 | 改动量 | 风险 | 适合阶段 |
|------|------|--------|------|----------|
| A 单进程双模式 | cordis.yml mode: both，双插件集共面板 | 大 | 高（媒体模型/端口/状态耦合）| 长期（若确定要单一进程）|
| **B 统一门户（推荐 v1）** | 新增 apps/portal：:9000 门户页，iframe 分页签 + 聚合状态卡 | **低** | 低（两个后端保持独立）| **现在可做** |
| C 反向代理 | nginx 子路径 + 导航页 | 低 | 中（引入外部依赖）| 需要公网/单域名时 |
| D 微前端 | single-spa 壳 | 高 | 高 | 不推荐 |

### B 方案设计（推荐）

- 新增 `apps/portal`：纯静态页（Node http 服务 :9000，或并入 video 的 web 静态路由）；
- 页面结构：顶部聚合状态条（video/audio 的 /api/status 定时轮询 + 健康徽章）
  + 分页签「📺 视频」「📻 电台」，内容为 `<iframe src=http://127.0.0.1:8100>` / `:8000`；
- 两个面板需允许被 iframe（无 X-Frame-Options，现状已满足）；深链 `?tab=audio`；
- 一键启停：门户页直接调用两后端已有的 /api/shutdown（仅本机，门户也跑本机 ✓）。

### 里程碑（每步可独立提交）

| 步 | 内容 | 预估 |
|----|------|------|
| 1 | ✅ apps/portal 骨架（静态页 + :9000 服务 + iframe 分页签）| 低（~1h）|
| 2 | ✅ 聚合状态卡（双 /api/status 轮询 + 停止按钮 + 离线提示）| 低 |
| 3 | （可选）nginx/Caddy 单域名子路径，门户设为默认页 | 中 |

## 二、音频面板设置 UI（对齐视频面板）

### 现状（已核查源码）

- 音频面板 = `web-src/`（Vite，无框架）：index.html(2.9KB) + main.js(166 行，
  `$`/toast/api/refresh 模式) + style.css；构建产物在 `public/`；
- 后端已就绪：`audio.relay` 命名空间（defaultBitrate 8-512）+ GET/PUT /api/settings/audio.relay
  （revision 乐观锁，409 冲突）——只差前端。

### 设计（与视频面板保持一致 + 调研改进）

1. index.html 增「⚙️ 设置」卡片：码率数字输入（8-512）+ 保存状态文案；
2. main.js 增 loadSettings/saveSettings：加载时记录 revision；变更即存（带 300ms 防抖自动保存——
   调研确认 debounce autosave 优于手动保存按钮）；409 时 toast 提示并重载（乐观更新 + 干净回滚，
   参考 137foundry「Optimistic UI Updates That Roll Back Cleanly」的 reload-on-conflict 模式）；
3. 构建：`npm run build:web`（vite 已在 devDeps）；输出 public/ 入库。

| 步 | 内容 | 预估 |
|----|------|------|
| 1 | ✅ index.html 设置卡片 + style.css | 低 |
| 2 | ✅ main.js load/save（400ms 防抖自动保存 + 409 乐观回滚 + toast）| 低 |
| 3 | ✅ 构建（vite 4 modules）+ 面板服务验证 + 冒烟 12/12 | 低 |

## 三、调研引用

- 微前端价值判断：feature-sliced.design《Micro-Frontends: Are They Still Worth It in 2025?》
  <https://feature-sliced.design/ru/blog/micro-frontend-architecture>
- 自托管面板聚合：awesome-selfhosted（Dashy/Homarr/Heimdall 条目）
  <https://github.com/awesome-selfhosted/awesome-selfhosted>；部署指南
  <https://www.vps1111.com/homarr-dashy-vps-navigation-guide.html>
- 设置页乐观更新与回滚：137Foundry《How to Implement Optimistic UI Updates That Roll Back Cleanly》
  <https://137foundry.com/articles/how-to-implement-optimistic-ui-updates-that-roll-back-cleanly>
