// config plugin — resolves runtime configuration and locates the
// ffmpeg + mediamtx binaries. Provides `ctx.config` to every other service.
import { Service } from 'cordis'
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

// ---- cordis.yml 配置 schema（校验器来自 @relay/core，与音频应用共用）----
// schema 表留在各应用（字段不同），校验逻辑共享
const CONFIG_SCHEMA = {
  port: { type: 'number', min: 1, max: 65535 },
  host: { type: 'string' },
  pathName: { type: 'string' },
  transcode: { type: 'boolean' },
  rtspPort: { type: 'number', min: 1, max: 65535 },
  hlsPort: { type: 'number', min: 1, max: 65535 },
  webrtcPort: { type: 'number', min: 1, max: 65535 },
  record: {
    type: 'object',
    fields: {
      enabled: { type: 'boolean' },
      dir: { type: 'string' },
    },
  },
  mediamtx: {
    type: 'object',
    fields: {
      dir: { type: 'string' },
      yml: { type: 'string' },
      apiAddress: { type: 'string' },
    },
  },
  ffmpegDir: { type: 'string' },
  presetsFile: { type: 'string' },
  channelsDir: { type: 'string' },
  liveDir: { type: 'string' },
  pythonCmd: { type: 'string' },
}

import { validateConfig } from '@relay/core/src/config-validate.js'

export default function configPlugin(ctx, config = {}) {
  // 启动即校验：yml 拼错/类型错当场报错退出，而不是运行中静默降级
  validateConfig(config, CONFIG_SCHEMA, 'config')

  const port = Number(process.env.PORT) || config.port || 8100
  const host = config.host || '0.0.0.0'
  const pathName = config.pathName || 'live'
  const transcode = config.transcode === true
  const rtspPort = Number(config.rtspPort) || 8554
  const hlsPort = Number(config.hlsPort) || 8888
  const webrtcPort = Number(config.webrtcPort) || 8889
  const record = Object.assign(
    { enabled: false, dir: 'recordings' },
    config.record || {}
  )
  const mediamtx = Object.assign(
    { dir: 'mediamtx', yml: 'mediamtx.yml', apiAddress: '127.0.0.1:9997' },
    config.mediamtx || {}
  )
  const ffmpegDir = config.ffmpegDir || 'ffmpeg'
  const presetsFile = path.resolve(ROOT, config.presetsFile || 'presets.json')
  const channelsDir = config.channelsDir || 'playlists'
  const liveDir = config.liveDir || 'src/live'
  const pythonCmd = config.pythonCmd || 'python'

  const ffmpeg = detectBinary(ROOT, ffmpegDir, 'ffmpeg')
  const mediamtxExe = detectBinary(ROOT, mediamtx.dir, 'mediamtx')
  const mediamtxYml = path.resolve(ROOT, mediamtx.yml)

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
    pathName,
    transcode,
    rtspPort,
    hlsPort,
    webrtcPort,
    record,
    mediamtx: {
      dir: mediamtx.dir,
      yml: mediamtxYml,
      apiAddress: mediamtx.apiAddress,
    },
    ffmpegDir,
    presetsFile,
    channelsDir,
    liveDir,
    pythonCmd,
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
