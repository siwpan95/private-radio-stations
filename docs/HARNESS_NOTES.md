# 借鉴 deepseek-harness「一切皆插件」架构的笔记

> 分析对象：`G:\notpython\deepseek-harness-master`。结论先行：我们的项目已站在正确框架上
> （cordis + Service + inject + yml 加载 + 生命周期事件）；harness 真正值得抄的是框架之上的
> **「配置即声明、启动即审计、运行即断言」的装配纪律**。

## 已落地（本轮）

| 模式 | harness 出处 | 本项目实现 |
|------|-------------|-----------|
| P1 启动结算审计 + fail-loud | `packages/boot/app-boot` assertEntriesLoaded / installFailLoud | `src/loader.js` 逐个 await 插件 fiber、失败点名带 stack；应用后核对同名 Service 是否注册；`src/index.js` unhandledRejection → 落盘 + exit(1) |
| P2 错误链解包日志 | `vendor/cordis/src/logger.ts` Error.cause/AggregateError | `src/plugins/logfile.js` fmtArg 展开 cause 链与 AggregateError.errors |
| P3 `!!js` 配置表达式 | `vendor/loader/src/config/utils.ts` evaluate/interpolate | `src/loader.js` 注册 `tag:yaml.org,2002:js`，作用域受控（process/env/path/__dirname/root），yml 可写 `port: !!js "process.env.PORT || 8100"` |
| P10b 多 dispatch 模式 | `vendor/cordis/src/events.ts` emit/waterfall/… | `station.setRelay` 前走 `ctx.waterfall('relay:pre-start', current)`，监听器返回 false 可否决开播 |

## 路线图（按性价比排序）

- 🟢 **P4 标准 schema 库**（中成本）：用 schemastery/zod 替换手写 validateConfig，集中 default 与校验；
- 🟡 **P5 运行时不变量**（中成本）：station 状态机断言（relay:start/stop 配对、sources FIFO 守恒、failureCount ≤ maxFailures），写一个简版 ctx.invariants 服务；
- 🟡 **P6 Entry 行式配置**（中成本）：cordis.yml 从 map 改为 `{ id, name, config, disabled, inject }` 行数组，为 patch/热重载打地基；
- 🔵 **P7 patch 分层**（中成本，依赖 P6）：出厂 cordis.yml + 用户 cordis.patch.yml 按 id 覆盖，本地改动与升级解耦；
- 🔵 **P8 配置热重载**（高成本，依赖 P6/P7）：fs.watch + 事务式 update + 失败回滚到「最后已知良好」树；
- ⚪ **P9 分层设置服务**：仅当要让面板运行时写配置才值得（schema + revision 乐观锁 + 脱敏）；
- ⚪ **P10a 隔离 realm（ctx.isolate）**：单实例转播站收益趋近于零，不做。

harness 关键参考文件：`vendor/cordis/src/{context,service,registry,fiber,events,reflect,logger}.ts`、
`vendor/loader/src/config/{entry,group,tree,utils}.ts`、`vendor/schemastery/`、
`packages/runtime-diagnostics/invariants/README.md`、`examples/headless-agent/cordis.yml`。
