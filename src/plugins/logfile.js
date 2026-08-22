// logfile plugin — 文件日志 + 内存错误环。
// 把 ctx.logger 的各级别输出同步追加到 data/logs/radio.log（超限截断保留后半），
// 并在内存保留最近 N 条 error/fatal（供 /api/status 健康接口展示，参考
// deepseek-harness 的 runtime-diagnostics 思路）。
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'

const MAX_BYTES = 2 * 1024 * 1024      // 日志文件上限：超过则保留后半 1MB
const RING_SIZE = 30                   // 内存错误环容量

function fmtArg(a) {
  if (typeof a === 'string') return a
  try { return util.inspect(a, { depth: 3, breakLength: 200 }) } catch { return String(a) }
}

class LogfileService extends Service {
  constructor(ctx) {
    super(ctx, 'logfile')
    const root = (ctx.config && ctx.config.root) || process.cwd()
    const dir = path.resolve(root, 'data', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'radio.log')
    this.bytes = 0
    try { this.bytes = fs.statSync(this.file).size } catch { /* ignore */ }
    this.errors = []

    // 在日志文件头部写一条启动分隔线
    this.appendLine('======== ' + new Date().toISOString() + ' 服务启动 ========')

    // 接管 ctx.logger 的各级别方法：先落盘，再走原输出
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal', 'success']) {
      if (typeof ctx.logger[level] !== 'function') continue
      const orig = ctx.logger[level].bind(ctx.logger)
      ctx.logger[level] = (...args) => {
        const line = args.map(fmtArg).join(' ')
        try {
          this.appendLine('[' + new Date().toISOString() + '] [' + level + '] ' + line)
          if (level === 'error' || level === 'fatal') {
            this.errors.push(line)
            if (this.errors.length > RING_SIZE) this.errors.shift()
          }
        } catch { /* 日志失败不影响主流程 */ }
        return orig(...args)
      }
    }
  }

  appendLine(line) {
    try {
      fs.appendFileSync(this.file, line + '\n')
      this.bytes += Buffer.byteLength(line) + 1
      if (this.bytes > MAX_BYTES) {
        // 超限：保留后半（简单粗暴，够个人电台用）
        const buf = fs.readFileSync(this.file)
        const keep = buf.subarray(Math.max(0, buf.length - MAX_BYTES / 2))
        fs.writeFileSync(this.file, keep)
        this.bytes = keep.length
      }
    } catch { /* ignore */ }
  }

  recentErrors() {
    return this.errors.slice()
  }

  status() {
    return { file: this.file, bytes: this.bytes, errors: this.errors.length }
  }
}

LogfileService.inject = ['config']

export default function logfilePlugin(ctx) {
  ctx.plugin(LogfileService)
}
