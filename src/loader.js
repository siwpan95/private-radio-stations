// Minimal Cordis-style loader: reads cordis.yml, dynamically imports each
// plugin module, registers it with its config, waits for async application to
// settle, then emits `ready`. This reproduces @cordisjs/plugin-loader's
// yml-driven lifecycle without pulling in its (fork-specific) dependency tree,
// keeping the toolchain robust on this machine.
//
// Plugins in Cordis are applied asynchronously (a tick after registration), so
// services are only guaranteed to exist after the `await` below.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function start(ctx, yamlPath = path.join(__dirname, '..', 'cordis.yml')) {
  const raw = await readFile(yamlPath, 'utf8')
  const doc = yaml.load(raw) || {}
  const plugins = doc.plugins || {}

  for (const [name, cfg] of Object.entries(plugins)) {
    const mod = await import(`./plugins/${name}.js`)
    const plugin = mod.default
    if (typeof plugin !== 'function') {
      throw new Error(`plugin "${name}" has no default function export`)
    }
    ctx.plugin(plugin, cfg || {})
  }

  // Let Cordis finish applying every plugin (async), then signal readiness.
  await new Promise((resolve) => setTimeout(resolve, 0))
  ctx.emit('ready')
  return ctx
}
