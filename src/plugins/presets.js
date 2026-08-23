// presets plugin — read/write presets.json with dedupe + atomic write.
// 预设结构：{ name, url, desc?, icon? }（与电台项目 presets.json 同风格）
import { Service } from 'cordis'
import fs from 'node:fs'

class PresetsService extends Service {
  constructor(ctx) {
    super(ctx, 'presets')
  }

  get file() {
    return this.ctx.config.presetsFile
  }

  list() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return []
    }
  }

  add(item) {
    const { name = '', url = '', desc = '', icon = '' } = item || {}
    if (!url) return this.list()
    const list = this.list()
    if (list.some((p) => p.url === url)) return list // dedupe by url
    list.push({ name: name || url, url, desc, icon })
    this._write(list)
    return list
  }

  remove(url) {
    const list = this.list().filter((p) => p.url !== url)
    this._write(list)
    return list
  }

  _write(list) {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, this.file) // atomic replace
  }
}

PresetsService.inject = ['config']

export default function presetsPlugin(ctx) {
  ctx.plugin(PresetsService)
}
