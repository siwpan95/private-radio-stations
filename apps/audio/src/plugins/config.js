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

// ---- cordis.yml 配置 schema（校验器来自 @relay/core，与视频应用共用）----
// schema 表留在各应用（字段不同），校验逻辑共享
const CONFIG_SCHEMA = {
  port: { type: 'number', min: 1, max: 65535 },
  host: { type: 'string' },
  defaultBitrate: { type: 'number', min: 8, max: 512 },
  chunkSize: { type: 'number', min: 256, max: 65536 },
  transcodeMounts: { type: 'array', of: 'number', min: 1 },
  hls: {
    type: 'object',
    fields: {
      enabled: { type: 'boolean' },
      dir: { type: 'string' },
      segmentSec: { type: 'number', min: 1, max: 30 },
      listSize: { type: 'number', min: 1, max: 60 },
      deleteThreshold: { type: 'number', min: 0 },
      variants: { type: 'array', of: 'number', min: 1 },
    },
  },
  ffmpegDir: { type: 'string' },
  presetsFile: { type: 'string' },
}

import { validateConfig } from '@relay/core/src/config-validate.js'

export default function configPlugin(ctx, config = {}) {
  // 启动即校验：yml 拼错/类型错当场报错退出，而不是运行中静默降级
  validateConfig(config, CONFIG_SCHEMA, 'config')

  const port = Number(process.env.PORT) || config.port || 8000
  const host = config.host || '0.0.0.0'
  const defaultBitrate = config.defaultBitrate || 128
  const chunkSize = config.chunkSize || 4096
  const transcodeMounts = Array.isArray(config.transcodeMounts)
    ? config.transcodeMounts.slice()
    : [64, 320]
  const hls = Object.assign(
    { enabled: true, dir: 'hls', segmentSec: 4, listSize: 6, deleteThreshold: 3, variants: [128, 64] },
    config.hls || {}
  )
  if (!Array.isArray(hls.variants) || !hls.variants.length) {
    hls.variants = [Number(hls.bitrate) || 128]
  }
  const ffmpegDir = config.ffmpegDir || 'ffmpeg'
  const presetsFile = path.resolve(ROOT, config.presetsFile || 'presets.json')

  const ffmpeg = detectFfmpeg(ROOT, ffmpegDir)

  // 应用版本号（package.json），供 /api/status 输出
  let version = 'unknown'
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    /* ignore */
  }

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
    version,
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
