# 网络增强指南（本机实测 2026-08-23）

本机网络环境：GitHub 主站/raw/API 不可达，npm 官方源不可达，部分海外 CDN 不可达；
gitee、npmmirror、jsdelivr、部分海外 CDN（mux/apple/unified-streaming）可用。

## 1. GitHub 镜像实测结果

| 镜像 | 状态 | 用途 |
|------|------|------|
| `https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/<file>` | ✅ 快（91KB/s+）| **仓库文件**（≤20MB）——最推荐 |
| `https://ghfast.top/https://github.com/...` | ✅ 可用（慢 ~5KB/s）| Release 压缩包、raw、任意 github.com 链接 |
| `https://gitclone.com/github.com/...` | ⚠️ 时好时坏 | git clone 加速 |
| gitee.com/organizations/mirrors | ✅ | 热门项目镜像仓库 |
| gh-proxy.com / ghproxy.net / bgithub.xyz / kkgithub 等 | ❌ 本机不可达 | — |

## 2. 常用命令速查

```bash
# 仓库文件（列表/源码/小文件）
curl -o f.m3u8 https://cdn.jsdelivr.net/gh/best-fan/iptv-sources@main/cn_all.m3u8

# Release 二进制（走 ghfast.top 代理，可断点续传 -C -）
curl -C - -o mediamtx.zip https://ghfast.top/https://github.com/bluenviron/mediamtx/releases/download/v1.20.1/mediamtx_v1.20.1_windows_amd64.zip

# git clone 全局加速（gitclone.com，配置一次）
git config --global url."https://gitclone.com/".insteadOf https://github.com/

# npm / pip 国内源
npm install --registry=https://registry.npmmirror.com
pip install requests -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 3. 项目内建工具

- **`node scripts/update-playlists.mjs`**：从镜像链（jsdelivr → ghfast.top → akams）更新 `playlists/` 下的 IPTV 列表，
  下载校验后原子替换；新增列表源在脚本顶部 TARGETS 加一行即可；
- **`scripts/dl_mtx.py`**：MediaMTX 发布包分片并行下载器（精确 Range 续传 + SHA256 校验），改 URL 即可复用；
- 面板「频道库」的导入功能同样支持任何 http(s) m3u 地址（含 jsdelivr 镜像地址）。

## 4. 转播源网络提示

- 海外测试源可用：mux.dev、apple devstreaming/devimages、demo.unified-streaming.com；
- 国内频道优先用面板预设/频道库中的国内 IPTV 源（央视/卫视），流畅度显著优于海外源；
- 平台解析（斗鱼/B站等）走国内 API，本机通常可用；Twitch/TikTok 类海外平台可能解析失败（网络原因，非解析器问题）；
- ffmpeg 拉流已带 `-reconnect` 系列参数，断线自动重连；单源多次失败会自动切备用源。

## 5. 更深层的网络方案（如需长期解决）

- **dev-sidecar**（github.com/docmirror/dev-sidecar）：本地代理 + DNS 优化，一劳永逸但需常驻；
- **hosts 方案**（ineo6.github.io/hosts）：定期更新 GitHub 等域名的可用 IP，简单但有维护成本；
- Cloudflare WARP / 合规代理：影响全局网络，自行评估。
