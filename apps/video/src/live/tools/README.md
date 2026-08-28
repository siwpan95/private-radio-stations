# live/tools — real-url 逆向工具

本目录存放实时平台逆向的辅助工具（不参与运行时，resolve.py 不引用）。

## probe_capture.py — 通用 Playwright+Edge 无头抓包探针

静态 JS 分析解不开时的决定性手段：加载目标页 → 捕获真实网络请求（媒体流/API/
签名参数）→ JSON 落盘。浏览器用系统 Edge，无需下载内核。

```bash
# 依赖（Python 3.10+）
pip install playwright

# 基础用法：抓房间页媒体/接口请求，观测 15s
python probe_capture.py https://v.6.cn/1111520

# 移动端 UA + 点击播放器触发播放（央视频这类不自动播的站点）
python probe_capture.py "https://m.yangshipin.cn/tv?vid=2024078201&pid=600001859" --ua mobile --click 195,300

# 自定义过滤 + 延长观测
python probe_capture.py https://live.douyin.com/870887192950 --filter "m3u8|flv|webcast" --wait 20 --out dy.json

# 全量不过滤
python probe_capture.py <url> --all
```

常用参数：`--ua desktop|mobile`、`--wait N`、`--click X,Y`（可多次）、
`--js "EXPR"`（执行页面内 JS，播放器触发常用，如
`--js "(function(){var v=document.querySelector('video');v&&v.play()})()"`）、
`--filter REGEX`、`--out PATH`、`--headed`、`--browser edge|chromium`。
Edge 未装在默认路径时用环境变量 `PROBE_EDGE=<msedge.exe>` 指定。
默认启用 `--autoplay-policy=no-user-gesture-required`（放行无手势自动播放，
多数播放器因此自动发起拉流）；`--no-autoplay` 关闭。

输出 JSON（不入库，见 .gitignore）：
`{meta:{url,ua,wait,clicks,filter,ts,browser}, captures:[{type,method,status,url,body}]}`
——`body` 为命中响应的前 4KB 文本；媒体二进制乱码正常，看 status/URL 即可。

### 实战案例（2026-08 批次，全部由此工具拿到金标准证据）

| 平台 | 命令要点 | 战果 |
|---|---|---|
| 六间房 | `probe_capture.py https://v.6.cn/1111520` | 抓到播放器真实请求 `httpflv/{flvtitle}.flv?os=9&page=room&ruid={uid}`（302→CDN 200）；再结合移动端 JS 的 makeStreamingUrl 定位免参数直链 `liverecord/{flvtitle}.flv` |
| 央视频 | `--ua mobile --click 195,300` 触发播放 | 抓到 h5access `limit_play`/`h5_live_poll` 端点与现行 pid（600001859）；再抓 `ysplayer.modern.*.js` 定位 ckey 两段式算法（Ut 混淆函数，Node shim 对照复刻） |
| 抖音 | `probe_capture.py https://live.douyin.com/870887192950` | 确认 SSR 内嵌 `RENDER_DATA`/`roomStore` 流地址（免签名），并交叉印证 webcast web/enter 签名请求形态 |

## yangshipin_ut_shim/ — 央视频 ckey 混淆函数执行单元

`ysplayer` 的 ckey 生成器 `Ut` 是控制流平坦化混淆函数，手工反混淆不划算。
该 shim 把 webpack bundle 中 Ut 所在模块提取为自包含单元（CryptoJS + 常量 +
stub document/window/navigator），Node 直接执行输出 ckey，供 Python 复刻时
逐字节对照。用法见 shim 内 README.md。
