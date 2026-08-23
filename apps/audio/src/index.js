// Bootstrap: build the Cordis root context, load plugins from cordis.yml, and
// wire graceful shutdown. Run with:  node src/index.js   (or start-radio.bat)
import { Context } from 'cordis'
import { start } from './loader.js'

const ctx = new Context()

await start(ctx)
ctx.logger.info('private-radio-stations (Node.js + Cordis) started')

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  ctx.logger.info(`received ${signal}, shutting down`)
  ctx.emit('dispose')
  // Give disposers (ffmpeg kill, server close) a moment, then exit.
  setTimeout(() => process.exit(0), 400)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// 未捕获异常也落盘（logfile 插件已接管 ctx.logger），方便后台运行时排障
process.on('uncaughtException', (err) => {
  try { ctx.logger.error('uncaughtException: ' + (err && err.stack ? err.stack : err)) } catch { /* ignore */ }
  console.error(err)
})
process.on('unhandledRejection', (reason) => {
  try { ctx.logger.error('unhandledRejection: ' + reason) } catch { /* ignore */ }
})
