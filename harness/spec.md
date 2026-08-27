# 编排 harness 契约 spec（private-radio-stations）

> 对齐 E:\lab port_spec.txt 思路：本文件是 harness 用例的单一真相来源；实现与 spec 冲突时以 spec 为准。

## 协议

- 行分隔 JSON（JSON-lines）：请求 {id, cmd, ...}；响应 {id, ok, value, error}；启动先回 {ready:true}。
- 逐请求超时：manifest timeout（radio-gate 400s，全量门禁含 7 个单测套件）。
- 生命周期：子进程由 port.mjs 登记 effect，harness 退出/dispose 时 kill（可逆效应）；stderr 抽干防死锁。

## cmd 集

| cmd | 语义 | 黄金值 |
|---|---|---|
| check | scripts/check.mjs 全量门禁：语法 + cordis.yml + package.json + 7 个单测套件 | exit 0 |
| fast | scripts/check.mjs --fast（pre-commit 同款：语法 + 配置 + 元数据，不跑单测） | exit 0 |

## 分层纪律

- **离线黄金值**只覆盖本表两 cmd；video/radio 端到端 smoke（scripts/smoke.mjs）需要运行中的服务 + ffmpeg + 网络测试源，属在线冒烟层，由 npm run smoke:* 手动执行，不纳入 harness。
- 无新增端口；服务端口登记见 G:\docs\md\allin主工作区\ports.yaml / 端口分配表.md。
- 运行：node harness/harness.mjs；全绿 exit 0，任何分歧/报错 exit 1。

## E4/E5（2026-08-27 补）

- E4 eval-invariant：expectConsensus:true 的用例出现任何分歧/报错/失配 = 真失败（exit 1）；informational 用例（expected:null）可声明 expectDiverged 名单，超出预期分歧同样失败。
- E5 分歧事件订阅链路：分歧/报错事件以 JSON-lines 追加到 data/divergence-events.jsonl（可用 DIVERGENCE_EVENT_FILE 环境变量改路径），每条含 ts/case/consensus/expected/expectDiverged/diverged/errors/components（registry snapshot 健康快照），供 CI/上层订阅与告警。
