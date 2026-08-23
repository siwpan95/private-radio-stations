# 📡 IPTV 频道库（playlists/）

内置播放列表来自 [best-fan/iptv-sources](https://github.com/best-fan/iptv-sources)（MIT 许可），
为该项目 2026-08-23 自动构建的国内频道列表快照：

| 文件 | 内容 |
|------|------|
| `cctv.m3u8` | 央视频道（约 32 个频道，每频道多源）|
| `province.m3u8` | 卫视频道（约 36 个频道）|
| `all.m3u8` | 完整列表（约 71 个频道）|
| `pay.m3u8` | 付费频道 |

说明：
- 同一频道名下多个源会被合并：转播时第一个为主源、其余自动作为 failover 备用源；
- 源地址由第三方维护，**随时可能失效或限地区/限运营商**，失效时可重新导入最新列表；
- 更新方法：面板「导入播放列表」填最新 m3u 地址，或直接替换本目录文件；
  上游自动更新地址（jsdelivr 镜像）：
  `https://cdn.jsdelivr.net/gh/best-fan/iptv-sources@main/cn_cctv.m3u8`（cn_all / cn_province / cn_pay 同理）。
