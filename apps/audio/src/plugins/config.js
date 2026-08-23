// config plugin — resolves runtime configuration and locates the ffmpeg binary.
// Provides `ctx.config` to every other service.
// 配置校验与默认值由 schemastery 声明式 schema 承担（HARNESS P4）。
import { Service } from 'cordis'
import Schema from 'schemastery'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..') // src/plugins -> src -> root

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

// ---- cordis.yml 配置 schema（schemastery 声明式）----
const ConfigSchema = Schema.object({
  port: Schema.number().min(1).max(65535).default(8000),
  host: Schema.string().default('0.0.0.0'),
  defaultBitrate: Schema.number().min(8).max(512).default(128),
  chunkSize: Schema.number().min(256).max(65536).default(4096),
  transcodeMounts: Schema.array(Schema.number()).default([64, 320]),
  hls: Schema.object({
    enabled: Schema.boolean().default(true),
    dir: Schema.string().default('hls'),
    segmentSec: Schema.number().min(1).max(30).default(4),
    listSize: Schema.number().min(1).max(60).default(6),
    deleteThreshold: Schema.number().min(0).default(3),
    variants: Schema.array(Schema.number()).default([128, 64]),
  }).default({}),
  ffmpegDir: Schema.string().default('ffmpeg'),
  presetsFile: Schema.string().default('presets.json'),
})

export default function configPlugin(ctx, rawConfig = {}) {
  let config
  try {
    config = new ConfigSchema(rawConfig)
  } catch (e) {
    throw new Error('cordis.yml 配置错误（plugins.config）：' + (e && e.message ? e.message : e), { cause: e })
  }

  const port = Number(process.env.PORT) || config.port
  const transcodeMounts = config.transcodeMounts.slice()
  const hls = { ...config.hls }
  if (!Array.isArray(hls.variants) || !hls.variants.length) {
    hls.variants = [128]
  }
  const presetsFile = path.resolve(ROOT, config.presetsFile)

  const ffmpeg = detectFfmpeg(ROOT, config.ffmpegDir)

  // 应用版本号（package.json），供 /api/status 输出
  let version = 'unknown'
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    /* ignore */
  }

  const cfg = {
    ...config,
    port,
    transcodeMounts,
    hls,
    presetsFile,
    root: ROOT,
    version,
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
    ctx.logger.info('ffmpeg: ' + ffmpeg)
  }

  ctx.plugin(ConfigService, cfg)
}
