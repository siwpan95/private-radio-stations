// streamer plugin — spawns ffmpeg to pull the active source and transcode
// it to per-client MP3 mounts. ffmpeg's own `-reconnect` network stack is
// used to pull the source (this is the same robust path HLS uses), so Node
// never has to proxy the live bytes itself. A Node fetch fallback is kept
// only for the no-ffmpeg case.
import { Service } from 'cordis'
import { spawn } from 'node:child_process'

// ffmpeg 拉流参数助手来自 @relay/core（与视频应用共用）
import { resolveSource, needsReconnect, RECONNECT_ARGS } from '@relay/core/src/ffmpeg-args.js'

export { resolveSource, needsReconnect, RECONNECT_ARGS }

class StreamerService extends Service {
  constructor(ctx) {
    super(ctx, 'streamer')
    this.children = new Set()
    ctx.on('dispose', () => this.killAll())
  }

  get station() {
    return this.ctx.station
  }

  // Spawn ffmpeg to transcode the active source to MP3 at `bitrate` kbps.
  // Returns the child process (child.stdout is the live MP3 byte stream),
  // or null if there is no active source or ffmpeg binary.
  async relayMount(bitrate) {
    let url = this.station.activeUrl()
    if (!url) return null
    url = await resolveSource(url)
    const ff = this.ctx.config.ffmpeg
    if (!ff) return null
    const args = [
      ...(needsReconnect(url) ? RECONNECT_ARGS : []),
      '-fflags', '+nobuffer',
      '-flags', 'low_delay',
      '-i', url,
      '-acodec', 'libmp3lame',
      '-b:a', `${bitrate}k`,
      '-f', 'mp3',
      '-',
    ]
    const child = spawn(ff, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    this.children.add(child)
    const cleanup = () => this.children.delete(child)
    child.on('exit', cleanup)
    child.on('error', cleanup)
    return child
  }

  // Node fetch fallback (only used when ffmpeg is unavailable). Yields raw
  // audio bytes of the active source with simple retry + failover.
  async *fetchStream() {
    let url = this.station.activeUrl()
    if (!url) return
    let attempts = 0
    while (attempts < 6) {
      try {
        const resp = await fetch(url, { headers: { 'Icy-MetaData': '1' } })
        if (!resp.ok || !resp.body) throw new Error('bad response ' + resp.status)
        const reader = resp.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) yield Buffer.from(value)
        }
        return
      } catch (e) {
        attempts += 1
        this.ctx.logger.warn(`fetch-stream error (${attempts}): ${e.message}`)
        this.station.noteFailure()
        url = this.station.activeUrl()
        if (!url) return
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  // P8B 服务 dispose 约定：热卸载时回收全部转码子进程
  dispose() {
    this.killAll()
  }

  killAll() {
    for (const c of this.children) {
      try { c.kill('SIGKILL') } catch { /* ignore */ }
    }
    this.children.clear()
  }
}
StreamerService.inject = ['config', 'station']

export default function streamerPlugin(ctx) {
  ctx.plugin(StreamerService)
}
