// Bootstrap: build the Cordis root context, load plugins from cordis.yml, and
// wire graceful shutdown. Run with:  node src/index.js   (or start-stream.bat)
import { Context } from 'cordis'
import { start } from '@relay/core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const ctx = new Context()

await start(ctx, {
  yamlPath: path.join(root, 'cordis.yml'),
  pluginsDir: path.join(__dirname, 'plugins'),
  root,
  watch: true, // P8A：cordis.patch.yml 热重载
})
import Schema from 'schemastery'

// P9：注册可面板编辑的运行时设置命名空间
ctx.settings.register(
  'video.relay',
  Schema.object({
    defaultTranscode: Schema.boolean().default(false),
    defaultRecord: Schema.boolean().default(false),
  }),
  { base: { defaultTranscode: !!ctx.config.transcode, defaultRecord: !!ctx.config.record.enabled } }
)

ctx.logger.info('local-video-relay (Node.js + Cordis + MediaMTX) started')

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  ctx.logger.info(`received ${signal}, shutting down`)
  // 先停转播（ffmpeg/录像子进程），再停 MediaMTX，最后关服务器
  try { ctx.station && ctx.station.stopRelay && ctx.station.stopRelay() } catch { /* ignore */ }
  ctx.emit('dispose')
  // Give disposers (ffmpeg / mediamtx kill, server close) a moment, then exit.
  setTimeout(() => process.exit(0), 800)
}

// 面板 API 关闭（web 插件 /api/shutdown）也走同一条优雅退出路径
process.on('message', (m) => {
  if (m === 'shutdown') shutdown('API')
})

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// 未捕获异常也落盘（logfile 插件已接管 ctx.logger），方便后台运行时排障
process.on('uncaughtException', (err) => {
  try { ctx.logger.error('uncaughtException: ' + (err && err.stack ? err.stack : err)) } catch { /* ignore */ }
  console.error(err)
})
process.on('unhandledRejection', (reason) => {
  try { ctx.logger.error('unhandledRejection: ' + (reason && reason.stack ? reason.stack : reason)) } catch { /* ignore */ }
  console.error(reason)
  // fail-loud（借鉴 harness installFailLoud）：后台长驻服务拒绝半死不活
  setTimeout(() => process.exit(1), 200)
})