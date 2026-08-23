# 归档区（archived）

两个电台项目的历史/剥离内容统一归档于此，对应 gitee
`siwpan/private-radio-stations` 的 `archived` 分支（覆盖推送）。

## 目录

| 目录 | 来源 | 说明 |
|------|------|------|
| `python-radio-v2/` | `legacy-python/`（原 Python 电台 2.x 快照） | Node.js 重写前的 Python 版（run.py + radio 包 + requirements） |
| `python-radio-relay-20260823/` | 2026-08-23 从 `G:\music\musickit\radio` 剥离 | 在线转播功能全套（目录搜索/预设/扩展/状态机/面板 UI），含剥离前全量源码与文件映射（见其 README.md） |
| `python-radio-experiments/` | `G:\music\musickit\radio\experiments` | 原始 9 份探索稿（1.py~9.txt），演进思路备份 |

## 现役位置（归档对象的继任）

- Python 电台（剥离转播后）：`G:\music\musickit\radio` → gitee `siwpan/music` 分支 `radio`
- Node.js 转播电台 3.0：`D:\private-radio-stations-2.0` → gitee `siwpan/private-radio-stations` 分支 `3.0`
