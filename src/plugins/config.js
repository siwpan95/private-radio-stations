// config plugin — resolves runtime configuration and locates the ffmpeg binary.
// Provides `ctx.config` to every other service.
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..') // src/plugins -> src -> root

// NOTE: F:\ffmpeg-8.1.2 and F:\ffmpeg-9.0.1 are *source trees* (configure /
// libavcodec / fftools ...), not built binaries — they cannot be executed.
// This project bundles a prebuilt binary at ffmpeg/ffmpeg.exe instead.
const FFMPEG_SOURCE_DIRS = ['F:\\ffmpeg-8.1.2', 'F:\\ffmpeg-9.0.1']

function detectFfmpeg(root, ffmpegDir) {
  const candidates = [
    path.join(root, ffmpegDir, 'ffmpeg.exe'),
    path.join(root, ffmpegDir, 'bin', 'ffmpeg.exe'),
    path.join(root, ffmpegDir, 'ffmpeg'),
    path.join(root, 'ffmpeg', 'ffmpeg.exe'),
    'ffmpeg', // fall back to PATH
  ]
  for (const c of candidates) {
    if (c === 'ffmpeg') {
      try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 })
        return 'ffmpeg'
      } catch {
        continue
      }
    }
    if (fs.existsSync(c)) return c
  }
  return null
}

class ConfigService extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'config')
    Object.assign(this, cfg)
  }
}

export default function configPlugin(ctx, config = {}) {
  const port = Number(process.env.PORT) || config.port || 8000
  const host = config.host || '0.0.0.0'
  const defaultBitrate = config.defaultBitrate || 128
  const chunkSize = config.chunkSize || 4096
  const transcodeMounts = Array.isArray(config.transcodeMounts)
    ? config.transcodeMounts.slice()
    : [64, 320]
  const hls = Object.assign(
    { enabled: true, dir: 'hls', segmentSec: 4, listSize: 6, deleteThreshold: 3, bitrate: 128 },
    config.hls || {}
  )
  const ffmpegDir = config.ffmpegDir || 'ffmpeg'
  const presetsFile = path.resolve(ROOT, config.presetsFile || 'presets.json')

  const ffmpeg = detectFfmpeg(ROOT, ffmpegDir)

  const cfg = {
    port,
    host,
    defaultBitrate,
    chunkSize,
    transcodeMounts,
    hls,
    ffmpegDir,
    presetsFile,
    root: ROOT,
    ffmpegSourceDirs: FFMPEG_SOURCE_DIRS,
    ffmpeg,
    ffmpegOk() {
      return !!this.ffmpeg
    },
  }

  if (!ffmpeg) {
    ctx.logger.warn(
      'ffmpeg not found — transcode mounts and HLS will be disabled. ' +
        'Bundled binary expected at ffmpeg/ffmpeg.exe'
    )
  } else {
    ctx.logger.info(`ffmpeg: ${ffmpeg}`)
  }

  ctx.plugin(ConfigService, cfg)
}
