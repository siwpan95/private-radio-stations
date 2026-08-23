// config plugin — resolves runtime configuration and locates the
// ffmpeg + mediamtx binaries. Provides `ctx.config` to every other service.
// 配置校验与默认值由 schemastery 声明式 schema 承担（HARNESS P4）。
import { Service } from 'cordis'
import Schema from 'schemastery'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..') // src/plugins -> src -> root

function detectBinary(root, dir, name, exts = ['', '.exe']) {
  const candidates = []
  for (const ext of exts) {
    candidates.push(path.join(root, dir, name + ext))
    candidates.push(path.join(root, dir, 'bin', name + ext))
  }
  candidates.push(path.join(root, name + '.exe'), path.join(root, name))
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // fall back to PATH
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore', timeout: 5000 })
    return name
  } catch {
    return null
  }
}

class ConfigService extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'config')
    Object.assign(this, cfg)
  }
}

// ---- cordis.yml 配置 schema（schemastery 声明式：校验 + 默认值一步到位）----
const ConfigSchema = Schema.object({
  port: Schema.number().min(1).max(65535).default(8100),
  host: Schema.string().default('0.0.0.0'),
  pathName: Schema.string().default('live'),
  transcode: Schema.boolean().default(false),
  rtspPort: Schema.number().min(1).max(65535).default(8554),
  hlsPort: Schema.number().min(1).max(65535).default(8888),
  webrtcPort: Schema.number().min(1).max(65535).default(8889),
  record: Schema.object({
    enabled: Schema.boolean().default(false),
    dir: Schema.string().default('recordings'),
  }).default({}),
  mediamtx: Schema.object({
    dir: Schema.string().default('mediamtx'),
    yml: Schema.string().default('mediamtx.yml'),
    apiAddress: Schema.string().default('127.0.0.1:9997'),
  }).default({}),
  ffmpegDir: Schema.string().default('ffmpeg'),
  presetsFile: Schema.string().default('presets.json'),
  channelsDir: Schema.string().default('playlists'),
  liveDir: Schema.string().default('src/live'),
  pythonCmd: Schema.string().default('python'),
})

export default function configPlugin(ctx, rawConfig = {}) {
  // 启动即校验：yml 拼错/类型错当场报错退出（schemastery 错误自带 JSON 路径）
  let config
  try {
    config = new ConfigSchema(rawConfig)
  } catch (e) {
    throw new Error('cordis.yml 配置错误（plugins.config）：' + (e && e.message ? e.message : e), { cause: e })
  }

  const port = Number(process.env.PORT) || config.port
  const presetsFile = path.resolve(ROOT, config.presetsFile)

  const ffmpeg = detectBinary(ROOT, config.ffmpegDir, 'ffmpeg')
  const mediamtxExe = detectBinary(ROOT, config.mediamtx.dir, 'mediamtx')
  const mediamtxYml = path.resolve(ROOT, config.mediamtx.yml)

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
    presetsFile,
    mediamtx: { ...config.mediamtx, yml: mediamtxYml },
    root: ROOT,
    version,
    ffmpeg,
    mediamtxExe,
    ffmpegOk() {
      return !!this.ffmpeg
    },
    mediamtxOk() {
      return !!this.mediamtxExe
    },
  }

  if (!ffmpeg) {
    ctx.logger.warn('ffmpeg not found — 无法拉流转播（期望位置 ffmpeg/ffmpeg.exe）')
  } else {
    ctx.logger.info('ffmpeg: ' + ffmpeg)
  }
  if (!mediamtxExe) {
    ctx.logger.warn('mediamtx not found — 无法本地分发（期望位置 mediamtx/mediamtx.exe）')
  } else {
    ctx.logger.info('mediamtx: ' + mediamtxExe)
  }

  ctx.plugin(ConfigService, cfg)
}
