import { Context, Service } from 'cordis'
const ctx = new Context()
let disposed = false
class Demo extends Service {
  constructor(x) { super(x, 'demo') }
  dispose() { disposed = true; console.log('[demo] dispose() called by cordis') }
}
const f = ctx.plugin(Demo, {})
if (f && typeof f.then === 'function') await f
await new Promise((r) => setTimeout(r, 50))
console.log('before: ctx.demo =', !!ctx.demo)
await f.dispose()
console.log('after: ctx.demo =', !!ctx.demo, '| dispose called =', disposed)
process.exit(0)