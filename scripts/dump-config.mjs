// dump-config.mjs — 打印某应用的生效配置树（base + patch 叠加后，含来源标注）。
// 用法：node scripts/dump-config.mjs <video|audio>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCordisYml, normalizeEntries, composeEntries, loadPatchFiles } from '@relay/core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const app = process.argv[2]
if (!['video', 'audio'].includes(app)) {
  console.error('用法：node scripts/dump-config.mjs <video|audio>')
  process.exit(1)
}

const appDir = path.join(ROOT, 'apps', app)
const yamlPath = path.join(appDir, 'cordis.yml')
const doc = parseCordisYml(fs.readFileSync(yamlPath, 'utf8'))
const norm = normalizeEntries(doc)
const patches = loadPatchFiles(yamlPath)
const entries = composeEntries(norm.entries, patches)

console.log('app: ' + app + ' | yml: ' + yamlPath + (norm.legacy ? ' [旧 map 形式]' : ' [行式]'))
console.log('patch: ' + patches.length + ' 条操作')
console.log('')
for (const e of entries) {
  const cfg = JSON.stringify(e.config, (k, v) => (v && typeof v === 'object' && v.__jsExpr !== undefined ? '<js: ' + v.__jsExpr + '>' : v))
  console.log(('[' + e.source + ']').padEnd(8) + ' ' + (e.disabled ? '[disabled] ' : '') + (e.hot ? '[hot] ' : '') + e.id.padEnd(12) + (e.module ? ' <- ' + e.module : '') + '  ' + (cfg.length > 110 ? cfg.slice(0, 110) + '…' : cfg))
}
