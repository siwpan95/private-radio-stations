# 📋 变更记录（CHANGELOG）

> 倒序记录重要改动。日常小修小补不在此列。

## 2026-08-04 — D1 HLS 直播切片（ABR 多码率）
- 新增 HLS 直播切片（`radio/hls.py` + `web.py` 的 `/hls/*` 路由）：把广播自动切成
  Safari / iOS / Android 原生可播的 HLS，入口恒为 `/hls/live.m3u8`。
- **音频 ABR 多码率自适应**：主播放列表 `live.m3u8` 经 `-master_pl_name` + `-var_stream_map`
  声明两档 `EXT-X-STREAM-INF`（BANDWIDTH 140800→v_128k、70400→v_64k）；单 ffmpeg 进程
  单解码多输出（`-map 0:a`×2 + `-b:a:0/1` 128k/64k），AAC-LC 编码原生兼容。
- 低延迟参数：切片 2 s（`HLS_SEGMENT_SEC`）、滚动窗口 8 片（`HLS_LIST_SIZE`），并配
  `independent_segments` + `program_date_time` + `delete_segments`。
- 正确性修复（P0）：ffmpeg stderr 由 PIPE 改为落 `hls_ffmpeg.log`，解除长驻进程管道死锁
  （此前 stderr 缓冲区撑满 → ffmpeg 阻塞 → playlist 冻结）。
- 缓存 / CORS 头（P1）：`.m3u8` 强制 `no-store`（防 CDN / 浏览器缓存致直播卡死），`.ts` 长缓存
  `immutable`，全开 CORS `*`。
- 配置化：`config.py` 新增 `HLS_SEGMENT_SEC / HLS_LIST_SIZE / HLS_DELETE_THRESHOLD / HLS_VARIANTS`。
- 观测性：`broadcaster.sub_count()`、`web.api_health` 返回 `subscribers`；面板 `hlsState`
  展示各码率就绪状态。

## ffmpeg 7.1 入项（与 cloudflared 同策略：二进制自带）
- `ffmpeg/` 目录内置 `ffmpeg.exe`（7.1，gyan.dev essentials）+ `ffprobe.exe`；`config.FFMPEG/FFPROBE`
  优先项目内、PATH 兜底。
- **决策**：保留 7.1，未还原机器上 2013 古董版（`ffmpeg.exe.bak2013` 仍作备份）。原因：旧版无
  `-hls_flags` 会导致 HLS 直接失败；7.1 其它项目也能受益，全局环境改动可接受。
- 备注：quick-tunnel 刚启动偶发 `530`（"origin not ready" 暖机），重试即恢复，非服务故障。
