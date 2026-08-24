import { Context, Service } from 'cordis'
const ctx = new Context()
function webPlugin(c, cfg) { c.plugin(class extends Service { constructor(x, cfg2) { super(x, 'web2') } }, cfg) }
const f = ctx.plugin(webPlugin, {})
if (f && typeof f.then === 'function') await f
await new Promise((r) => setTimeout(r, 50))
console.log('ctx.web2:', !!ctx.web2)
console.log('_disposables:', f._disposables && f._disposables.length)
if (f._disposables) {
  for (const d of f._disposables) console.log('  disposable:', d.constructor.name, '| keys:', Object.getOwnPropertyNames(d).slice(0, 12).join(','))
}
console.log('fiber.store:', f.store && Object.keys(f.store))
console.log('fiber._hooks:', f._hooks && f._hooks.length)
await f.dispose()
console.log('after dispose ctx.web2:', !!ctx.web2)
process.exit(0)