// presets plugin — read/write presets.json with dedupe + atomic write.
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

  add(name, url) {
    const list = this.list()
    if (list.some((p) => p.url === url)) return list // dedupe by url
    list.push({ name, url })
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
