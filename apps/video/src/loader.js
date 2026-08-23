// Cordis 风格 loader：读 cordis.yml → 动态 import src/plugins/<name>.js → 逐个
// 应用插件并审计就绪状态（借鉴 deepseek-harness 的启动结算纪律）：
//   - `!!js` 配置表达式：yml 里可写 `port: !!js "process.env.PORT || 8100"`；
//   - 每个插件逐个 await 应用，失败点名报出（带 stack），不让错误拖到 ready 之后；
//   - 应用完成后核对每个插件的同名 Service 是否真的注册（inject 缺失当场暴露）。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ---- !!js 配置表达式（对应 harness vendor/loader 的 evaluate/interpolate）----
// !!js 简写在 YAML 规范里映射到 tag:yaml.org,2002:js，注册必须用完整 URI
const JS_EXPR = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: String(data) }),
})
const JS_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPR])

const JS_SCOPE = {
  process,
  env: process.env,
  path,
  __dirname,
  root: ROOT,
}

function evaluateJs(expr) {
  // 作用域受控：仅暴露 process/env/path 等少量符号
  const fn = new Function('process', 'env', 'path', '__dirname', 'root', `return (${expr})`)
  return fn(JS_SCOPE.process, JS_SCOPE.env, JS_SCOPE.path, JS_SCOPE.__dirname, JS_SCOPE.root)
}

function interpolate(value) {
  if (value && typeof value === 'object' && value.__jsExpr !== undefined) {
    return evaluateJs(value.__jsExpr)
  }
  if (Array.isArray(value)) return value.map(interpolate)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v)
    return out
  }
  return value
}

export async function start(ctx, yamlPath = path.join(__dirname, '..', 'cordis.yml')) {
  const raw = await readFile(yamlPath, 'utf8')
  const doc = yaml.load(raw, { schema: JS_SCHEMA }) || {}
  const plugins = doc.plugins || {}
  const applied = []

  // 逐个应用并审计（对应 harness 的 assertEntriesLoaded/assertEntriesActivated）
  for (const [name, rawCfg] of Object.entries(plugins)) {
    let mod
    try {
      mod = await import(`./plugins/${name}.js`)
    } catch (e) {
      throw new Error(`[boot] 插件加载失败 ${name}: ${e && e.stack ? e.stack : e}`, { cause: e })
    }
    const plugin = mod.default
    if (typeof plugin !== 'function') {
      throw new Error(`[boot] 插件 "${name}" 没有默认导出函数`)
    }
    const cfg = interpolate(rawCfg || {})
    try {
      const fiber = ctx.plugin(plugin, cfg)
      if (fiber && typeof fiber.then === 'function') await fiber
      applied.push(name)
    } catch (e) {
      throw new Error(`[boot] 插件应用失败 ${name}: ${e && e.stack ? e.stack : e}`, { cause: e })
    }
  }

  // 核对同名 Service 是否注册（缺 inject 的依赖会在这里点名）
  const missing = applied.filter((name) => !ctx[name])
  if (missing.length) {
    throw new Error(`[boot] 以下插件应用后未注册同名服务（检查 Service.inject 依赖链）: ${missing.join(', ')}`)
  }

  ctx.emit('ready')
  return ctx
}