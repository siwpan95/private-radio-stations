// @relay/core — 声明式 loader（视频/音频应用共用）。
// 特性（借鉴 deepseek-harness 装配纪律）：
//   - `!!js` 配置表达式（yml 可写 port: !!js "process.env.PORT || 8100"）；
//   - 启动结算审计：逐个 await 插件 fiber，失败点名带 stack；
//   - 应用后核对每个插件的同名 Service 是否注册（inject 缺失当场暴露）。
//
// 用法：
//   import { Context } from 'cordis'
//   import { start } from '@relay/core'
//   const ctx = new Context()
//   await start(ctx, { yamlPath: 应用根/cordis.yml, pluginsDir: 应用根/src/plugins })
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

// !!js 简写在 YAML 规范里映射到 tag:yaml.org,2002:js，注册必须用完整 URI
const JS_EXPR = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: String(data) }),
})
const JS_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPR])

function evaluateJs(expr, scope) {
  // 作用域受控：仅暴露 process/env/path/__dirname/root
  const fn = new Function('process', 'env', 'path', '__dirname', 'root', 'return (' + expr + ')')
  return fn(scope.process, scope.env, scope.path, scope.__dirname, scope.root)
}

function interpolate(value, scope) {
  if (value && typeof value === 'object' && value.__jsExpr !== undefined) {
    return evaluateJs(value.__jsExpr, scope)
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope)
    return out
  }
  return value
}

// 供质量门禁等复用：按项目 schema（含 !!js）解析 cordis.yml 文本
export function parseCordisYml(text) {
  return yaml.load(text, { schema: JS_SCHEMA }) || {}
}

export async function start(ctx, opts = {}) {
  const yamlPath = opts.yamlPath || path.join(process.cwd(), 'cordis.yml')
  const pluginsDir = opts.pluginsDir || path.join(process.cwd(), 'src', 'plugins')
  const root = opts.root || path.dirname(yamlPath)
  const scope = { process, env: process.env, path, __dirname: path.dirname(yamlPath), root }

  const raw = await readFile(yamlPath, 'utf8')
  const doc = parseCordisYml(raw)
  const plugins = doc.plugins || {}
  const applied = []

  // 逐个应用并审计（对应 harness 的 assertEntriesLoaded/assertEntriesActivated）
  for (const [name, rawCfg] of Object.entries(plugins)) {
    let mod
    try {
      mod = await import(pathToFileURL(path.join(pluginsDir, name + '.js')).href)
    } catch (e) {
      throw new Error('[boot] 插件加载失败 ' + name + ': ' + (e && e.stack ? e.stack : e), { cause: e })
    }
    const plugin = mod.default
    if (typeof plugin !== 'function') {
      throw new Error('[boot] 插件 "' + name + '" 没有默认导出函数')
    }
    const cfg = interpolate(rawCfg || {}, scope)
    try {
      const fiber = ctx.plugin(plugin, cfg)
      if (fiber && typeof fiber.then === 'function') await fiber
      applied.push(name)
    } catch (e) {
      throw new Error('[boot] 插件应用失败 ' + name + ': ' + (e && e.stack ? e.stack : e), { cause: e })
    }
  }

  // 核对同名 Service 是否注册（缺 inject 的依赖会在这里点名）
  const missing = applied.filter((name) => !ctx[name])
  if (missing.length) {
    throw new Error('[boot] 以下插件应用后未注册同名服务（检查 Service.inject 依赖链）: ' + missing.join(', '))
  }

  ctx.emit('ready')
  return ctx
}
