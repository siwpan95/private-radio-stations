# 配置体系演进规划：P6-P9（只规划，未执行）

> 参照 `G:\notpython\deepseek-harness-master` 的 loader/settings 体系，结合本仓库现状（cordis 4.0.0-rc.8 +
> `packages/core` loader + schemastery 3.18 + monorepo 双应用）制定。
> 状态：**规划完成，未实施**。执行时按阶段提交，每阶段可独立回滚。

## 可行性预验证结果（2026-08-23 实测）

| 问题 | 结果 | 影响 |
|------|------|------|
| cordis `fiber.dispose()` 能否卸载插件？ | ✅ 可（`await fiber.dispose()` 后服务消失，可重新注册）| P8 热重载的事务式卸载/重应用可行 |
| schemastery 实例能否 JSON 序列化？ | ✅ 可（`JSON.stringify(instance)` 输出含默认值的普通对象）| P9 快照与 wire 传输可行 |
| schemastery 3.18 有无 `.simplify()`（剥离默认值写回）？ | ❌ 无 | P9 写回改为「只存用户显式设置的键」，读写合并时叠默认值，绕开 simplify |
| 服务持有独占资源（web 端口 / mediamtx 进程）时重载会怎样？ | ⚠️ 重载 `web`/`mediamtx` 会端口冲突/进程冲突 | P8 分两阶段：先做安全子集（白名单 + 事件式生效），完整重载需插件声明 `restart: true` |

---

## P6 行式配置（Entry 行 + 稳定 id）

**目标**：`cordis.yml` 从 `plugins: { name: cfg }` 映射改为行数组，每行有全局唯一 `id`，
错误信息带 `id`，行可独立 `disabled`，为 P7/P8 打地基。

**参照**：harness `vendor/loader/src/config/{entry,group,tree}.ts`（EntryOptions = { id, name, config, group, disabled, inject }）。

**设计**：

```yaml
# cordis.yml（新格式）
plugins:
  - id: config
    config:
      port: !!js "process.env.PORT || 8100"
  - id: logfile
    config: { file: data/logs/stream.log }
  - id: some-feature
    module: ./custom-plugin.js   # 可选：默认 src/plugins/<id>.js
    disabled: true               # 可整体关闭
```

- `core/src/loader.js` 增加 `normalizeEntries(doc)`：兼容旧的 map 形式（自动转 `{id: name}` 行并打废弃警告），
  归一化后按 id 建行、解析 module 路径（相对应用 `src/plugins/`）、逐行应用并审计；
- `parseCordisYml` 同时输出 `entries`（带来源标注）供 dump 与 diff 使用；
- 错误信息统一 `[boot] 插件 <id> ...`。

**任务拆解**（预计 2 个提交）：
1. loader 归一化 + 审计按 id（不破坏现有启动）；
2. 两个应用 cordis.yml 迁移为新格式 + loader 单测（map 兼容 / disabled / 错误带 id）。

**验收**：门禁全过；`disabled: true` 的行不加载且 audit 不报缺服务；错误信息可定位到行 id。

---

## P7 patch 分层（base + 用户 overlay）

**目标**：出厂 `cordis.yml`（入库）与本地差异（`cordis.patch.yml`，gitignore）分离，按 id 覆盖/增删，
升级不动本地配置。

**参照**：harness `apps/cli/src/profile-boot.ts` composeProfile()、`packages/boot/app-boot` applyEntryPatches。

**设计（简化版，不做 harness 的 tree insert 全量）**：

```yaml
# apps/<app>/cordis.patch.yml（可选，gitignore）
- id: config
  config: { port: 8200 }        # 整行 config 替换（深层合并到对象字段）
- id: logfile
  disabled: true                # 关掉某插件
- id: my-plugin                 # 新增行
  module: ./my-plugin.js
  before: web                   # 插入位置锚点（可选）
```

- `composeEntries(baseEntries, patches)`：按 id 覆盖（config 做浅层合并，数组整替换）、支持 insert/disable；
- `scripts/dump-config.mjs <app>`：打印生效树，每行标注来源（base / patch），排障时知道「这行配置是谁给的」；
- `.gitignore` 加 `cordis.patch.yml`；`CORDIS_PATCH` 环境变量可追加额外 patch 文件（如部署差异）。

**任务拆解**（预计 2 个提交）：
1. composeEntries + dump-config 脚本 + loader 接 patch（不启用热重载）；
2. 两应用接入 + 单测（覆盖/插入/禁用/深层合并）。

**验收**：改 patch 端口后 `dump-config` 显示生效值、启动用新端口；删除 patch 文件即回出厂。

---

## P8 配置热重载（事务式，先安全子集）

**目标**：改 `cordis.patch.yml` 免重启生效；任何失败回滚到「最后已知良好」树，服务不中断。

**参照**：harness `vendor/hmr` + `watchUserPatches()`（diff → 事务式 update → 失败回滚旧 fiber）。

**现状约束（实测）**：`web`（端口）、`mediamtx`（进程）、`streamer`（ffmpeg）持有独占资源，
dispose/重应用会导致端口冲突或进程重启——所以分两阶段：

**阶段 A：安全子集（推荐先做）**
- 只支持三类热变更：新增/删除插件行、`disabled` 切换（这些走 fiber dispose/apply，事务式回滚）；
- `config` 行的变更不重载 config 插件，而是由 config 服务对**白名单键**（如 `transcode`、
  `record.enabled`、`hls.variants`）发 `config:update` 事件，streamer/recorder/hls 监听并在
  「下一次动作」生效（不打断正在进行的转播）；
- `web`/`mediamtx`/`station` 等标记 `restart: true` 的行变更 → 拒绝热应用，日志提示需重启。

**阶段 B：完整重载（后做）**
- 全行 diff + 事务式重载：逐个 `await oldFiber.dispose()` → `apply(new)`，任一失败则按逆序回滚
  （dispose 新的、重放旧的 config），保留最后良好树；
- 需要插件约定 `inject` 依赖图校验（新行依赖的服务必须已存在）。

**实现要点**：fs.watch patch 文件（防抖 300ms）→ compose → diff（按 id：added/removed/config-changed）→
执行策略（A 或 B）→ 结果写 `data/logs`；启动审计照常跑。

**任务拆解**（阶段 A 预计 3 个提交）：
1. watcher + diff + 白名单事件（config:update）打通；
2. 新增/删除/disabled 行的事务式热应用 + 失败回滚；
3. 单测（文件变更 → 生效/回滚路径）+ 文档。

**验收**：改 transcode 白名单键 → 下次转播用新值且当前转播不断；新增插件行热生效；
故意写坏 patch → 日志报错且服务保持原状。

**P8B 实测（真机循环）**：热禁用 mediamtx → 进程停止、web 随级联正确下线（日志
「web 依赖缺失，跳过重应用（预期下线）」，无审计误报）；热恢复 → mediamtx 与 web 依序重应用，
端口重新监听、进程重新拉起。热禁用/恢复 web 同样通过。

---

## P9 分层设置服务（运行时设置 + 面板读写）

**目标**：面板可安全读写「运行时可调」设置（与启动配置分离），多端并发不互相覆盖，密钥脱敏。

**参照**：harness `packages/settings`（namespace schema + schema 默认 → base → 用户文档三层叠加 +
revision 乐观锁 + redactSecrets + provider publish）。

**设计**：

- `core/src/settings.js`：`ctx.settings` 服务；`register(ns, schema, { base })` 注册命名空间；
  解析值 = schema 默认 → base（cordis.yml 的 settings 段）→ 用户文档（`data/settings.json`）三层合并；
- **写回策略**：schemastery 无 simplify → 用户文档只存「用户显式设置的键」（PUT 的原样载荷），
  读取时按 schema 合并默认值——比 simplify 更简单且可解释；
- 并发控制：`data/settings.json` 记录 `revision`，PUT 带 `expectedRevision`，不符返回 409 SETTINGS_CONFLICT；
- 快照 `deep-freeze`；对外序列化走 `redactSecrets`（键名匹配 /key|token|secret|password/ 打码）；
- 变更发布：写成功后 `settings:update` 事件 + 文件 watcher（外部改文件也能热生效，与 P8 的机制复用）。

**v1 命名空间候选**：`video.relay`（defaultTranscode/defaultRecord）、`audio.relay`（defaultBitrate）。

**任务拆解**（预计 3 个提交）：
1. core settings 服务（三层合并 + revision + deep-freeze + 脱敏）+ 单测；
2. web API：`GET /api/settings/:ns`、`PUT /api/settings/:ns`（revision 冲突检测）；
3. 面板「设置」区块 + 两个命名空间落地 + watcher。

**验收**：双面板并发写 → 后者收 409；`/api/status` 输出中密钥字段被脱敏；外部改 settings.json 自动生效。

---

## 依赖关系与建议顺序

```
P6 ──> P7 ──> P8（阶段A → 阶段B）
P9 独立，可与 P7 并行（共享 watcher/合并工具）
```

| 阶段 | 状态 | 前置 |
|------|------|------|
| P6 | ✅ | 无 |
| P7 | ✅ | P6 |
| P8 阶段A | ✅ 完成（提交 bd43070） | P7 |
| P8 阶段B | ✅ 完成：级联闭包事务重载 + 服务 dispose() 约定 + 依赖缺失审计区分（预期下线 vs 真故障）+ 6 项单测 | P8A |
| P9 | 中（1-2 天） | 无（可并行） |

## 全局风险清单

1. cordis Proxy：服务方法里不要用私有字段（已有教训），P8 重载路径同样只走公开 API；
2. 热重载与进行中的转播：任何会 kill ffmpeg/mediamtx 的变更必须显式拒绝或延迟到空闲；
3. patch 与 settings 的职责边界要写进文档：启动结构（插件集/端口）归 patch，运行时参数归 settings；
4. ~~回滚幂等~~ 已落地：服务 dispose() 约定（WebBase/mediamtx/streamer/recorder/station/hls 均已实现），loader 卸载前手动调用；cordis 级联注销依赖者的行为已由「受影响闭包」显式管理。
