// Bootstrap: build the Cordis root context, load plugins from cordis.yml, and
// wire graceful shutdown. Run with:  node src/index.js   (or start-radio.bat)
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
  'audio.relay',
  Schema.object({
    defaultBitrate: Schema.number().min(8).max(512).default(128),
  }),
  { base: { defaultBitrate: Number(ctx.config.defaultBitrate) || 128 } }
)

ctx.logger.info('private-radio-stations (Node.js + Cordis) started')

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  ctx.logger.info(`received ${signal}, shutting down`)
  try { ctx.station && ctx.station.stopRelay && ctx.station.stopRelay() } catch { /* ignore */ }
  ctx.emit('dispose')
  setTimeout(() => process.exit(0), 600)
}

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
  setTimeout(() => process.exit(1), 200)
})