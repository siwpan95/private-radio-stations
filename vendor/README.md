# vendor/ 第三方源码归档规范

> 借鉴 deepseek-harness 的 vendor 规范：凡 vendor 进来的第三方源码，
> 必须记录来源、版本、同步方式与依赖关系；运行时**不**依赖本目录。

## 当前归档

| 目录 | 来源 | 版本 | 用途 | 运行时依赖 |
|------|------|------|------|-----------|
| `cordis/` | `cordis-main.zip`（Cordis 官方源码包） | 4.0.0-rc.8 同期 | 框架源码对照/查 API 行为 | **否**（运行时走 npm 的 `cordis@4.0.0-rc.8`） |

## 规范

1. **只归档、不改写**：vendor 内容保持上游原样；如需 patch，在 README 记录 patch 内容与理由。
2. **不参与构建**：`.gitignore` 已排除 `vendor/cordis/`；构建/运行只依赖 `package.json` 声明的依赖。
3. **来源可追溯**：每个归档条目写明来源 URL/压缩包名 + 版本。
4. **体积考虑**：源码归档体积大时保持本地不提交（本目录整体不入库）。

## 同步流程（以 cordis 为例）

1. 从官方发布页下载源码压缩包（本项目曾用 `cordis-main.zip`）
2. 解压到 `vendor/cordis/`（覆盖更新即可，目录不入库）
3. 需要核实行为差异时查 `vendor/cordis/` 源码，运行时行为以 node_modules 版本为准
