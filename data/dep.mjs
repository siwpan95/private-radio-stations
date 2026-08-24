import { Context, Service } from 'cordis'
const ctx = new Context()
ctx.plugin(class extends Service {
  constructor(x) { super(x, 'config'); Object.assign(this, {}) }
}, {})
class A extends Service { constructor(x, c) { super(x, 'a') } }
A.inject = ['config']
class B extends Service { constructor(x, c) { super(x, 'b') } }
B.inject = ['config', 'a']
function aPlugin(c, cfg) { c.plugin(A, cfg) }
function bPlugin(c, cfg) { c.plugin(B, cfg) }
const fa = ctx.plugin(aPlugin, {})
const fb = ctx.plugin(bPlugin, {})
await fa; await fb;
await new Promise((r) => setTimeout(r, 50))
console.log('before: a=', !!ctx.a, 'b=', !!ctx.b)
await fa.dispose()
console.log('after a dispose: a=', !!ctx.a, 'b=', !!ctx.b)
try { console.log('access b =', !!ctx.b) } catch (e) { console.log('access b threw:', e.message) }
process.exit(0)