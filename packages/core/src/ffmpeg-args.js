// @relay/core — ffmpeg 拉流通用参数助手（视频/音频应用共用）

// Best-effort playlist (.m3u/.m3u8/.pls) resolver. Returns a direct stream URL.
// Only fetches tiny text playlists; on any failure it returns the original
// URL so ffmpeg can attempt it directly.
export async function resolveSource(url) {
  if (!/(\.m3u8?|\.pls)(\?|$)/i.test(url)) return url
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000) })
    if (!resp.ok) return url
    const text = await resp.text()
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (/^https?:\/\//i.test(line) && !line.startsWith('#')) return line
    }
  } catch {
    /* ignore — fall through to original URL */
  }
  return url
}

// `-reconnect` 是 http(s)/rtmp/... 协议选项，本地文件输入会直接报错，
// 所以只对网络 URL 加。
export function needsReconnect(url) {
  try {
    return /^(https?:|rtmp:|rtsp:|mms:|srt:|udp:|tcp:)/i.test(new URL(url).protocol)
  } catch {
    return false // unparseable => treat as a local file path
  }
}

export const RECONNECT_ARGS = [
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_delay_max', '5',
]
