import { Context, Service } from 'cordis'
const ctx = new Context()
ctx.plugin(class extends Service {
  constructor(x) { super(x, 'config'); Object.assign(this, { port: 8100 }) }
}, {})
await new Promise((r) => setTimeout(r, 50))
class WebSvc extends Service {
  constructor(x, cfg) { super(x, 'web'); this.port = (cfg && cfg.port) || 1 }
  dispose() { console.log('[web] dispose called') }
}
WebSvc.inject = ['config', 'station', 'streamer', 'recorder', 'presets', 'logfile', 'mediamtx', 'channels', 'resolver', 'settings']
function webPlugin(c, cfg) { c.plugin(WebSvc, cfg) }
const f = ctx.plugin(webPlugin, {})
if (f && typeof f.then === 'function') await f
await new Promise((r) => setTimeout(r, 100))
console.log('ctx.web before:', !!ctx.web)
try { await f.dispose(); console.log('outer dispose ok') } catch (e) { console.log('outer dispose threw:', e.message) }
console.log('ctx.web after:', !!ctx.web)
process.exit(0)