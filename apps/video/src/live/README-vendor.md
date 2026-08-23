# 🛰️ 平台直播解析器（vendored from real-url）

本目录下的 59 个平台解析模块来自 [wbt5/real-url](https://github.com/wbt5/real-url)（GPL-2.0，
LICENSE 见本目录 `LICENSE` 文件）。仅本目录内代码适用 GPL-2.0，项目其余部分为 MIT。

接口约定：每个 `<platform>.py` 提供 `get_real_url(rid)` 返回播放地址（str/dict/list），
个别模块只有类方法（douyu），由 `resolve.py` 统一兜底；
`resolve.py` 是包装器：`python resolve.py <platform> <room>` 输出最后一行 JSON。

本机适配修改（相对上游）：
- `huya.py`：原脚本顶层 `input()` 已包进 `if __name__ == '__main__'`；
- `douyin.py`：原脚本无函数入口，已重构为 `get_real_url(url)`；
- `resolve.py` / `platforms.json` 为本项目新增。

依赖：`requests` / `PyExecJS`（需 Node）/ `pycryptodome`，见 `requirements.txt`。
解析超时 45s；平台接口经常变动，失效的模块属正常现象。
