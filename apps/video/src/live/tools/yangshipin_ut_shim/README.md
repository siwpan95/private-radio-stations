# yangshipin_ut_shim — 央视频 ckey 混淆函数执行单元

央视频（yangshipin.cn）播放器 `ysplayer` 的 ckey 生成器 `Ut` 是控制流平坦化 +
字符串重构的混淆函数，手工反混淆不划算。本目录把 webpack bundle 中 Ut 所在模块
提取为**自包含 Node 执行单元**：stub document/window/navigator + 内联 CryptoJS +
常量，直接跑出 ckey，供 Python 复刻时逐字节对照。

## 文件

- `run_ut3.js` — 执行单元（2026-08-29 与浏览器真实输出逐字节验证一致：
  WU/HASH/KEY/IV 全等）。第 7 行是样例调用：
  `Ut('2024078201','1787938000','1.44.1','ko7djb70_vbjvrg5gcm',4330701)`
  改这行参数即可算其他 vid/时间戳的 ckey。
- `ysplayer.modern.99d3df88.js` — 提取来源的完整播放器 bundle（743KB，留档备查）。

## 用法

```bash
node run_ut3.js
# 输出（样例参数）：
# WU: "|2024078201|1787938000|mg3c3b04ba|1.44.1|ko7djb70_vbjvrg5gcm|4330701|https://m.yangshipin.cn/|mozilla/5.0 (iphone; cpu|https://m.yangshipin.cn/|Mozilla|Netscape|Win32|"
# HASH: 632292714
# KEY:  4E2918885FD98109869D14E0231A0BF4
# IV:   16B17E519DDD0CE5B79D7A63A4DD801C
```

## 已确认的算法事实（与 yangshipin.py 的 `_make_ckey` 一一对应）

1. 密钥/IV 未变：AES-128-CBC + PKCS7，key `4E2918885FD98109869D14E0231A0BF4`、
   iv `16B17E519DDD0CE5B79D7A63A4DD801C`；密文 hex 大写，前缀 `--01`。
2. wu 格式：`|{vid}|{ts}|mg3c3b04ba|{appVer}|{guid}|{platform}|{url}|{ua}|{referrer}|Mozilla|Netscape|Win32|`
   （appVer 现行 1.44.1；url/ua/referrer 经 w() 截断 24 字符）。
3. 哈希：time33 变体 `(u<<5)-u+ord(ch); u&=u&0xffffffff`，取 int32。
4. 明文：`|{hash}{wu}`，`ckey = '--01' + AES_hex(xu).upper()`。
5. 两段式请求：首请求 cKey 用本地时间戳；服务端 `iretcode==32`（或返回 svrtick/
   curTime）时用服务端时间重算重试。

> 归属说明：本目录代码提取自央视频公开 H5 播放器 JS（逆向工程互操作复刻，仅作
> 算法对照研究）；live/ 目录整体 GPL-2.0，见上级 LICENSE。
