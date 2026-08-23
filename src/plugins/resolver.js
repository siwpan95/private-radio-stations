// resolver plugin — 调用 src/live/resolve.py（real-url 平台解析器，GPL-2.0）
// 获取直播平台真实流媒体地址。59 个平台模块接口统一：get_real_url(rid)。
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

class ResolverService extends Service {
  constructor(ctx) {
    super(ctx, 'resolver')
    this.platforms = []
    try {
      const p = path.resolve(this.liveDir, 'platforms.json')
      const list = JSON.parse(fs.readFileSync(p, 'utf8'))
      this.platforms = Array.isArray(list) ? list : []
    } catch {
      this.ctx.logger.warn('platforms.json 读取失败 — 平台解析不可用')
    }
  }

  get liveDir() {
    return path.resolve(this.ctx.config.root, this.ctx.config.liveDir || 'src/live')
  }

  get pythonCmd() {
    return this.ctx.config.pythonCmd || 'python'
  }

  platformsList() {
    // 热门平台排前面
    return [...this.platforms].sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0))
  }

  // 返回 { ok, url | error, raw? }
  resolve(platform, room) {
    const meta = this.platforms.find((p) => p.module === platform)
    if (!meta) return Promise.resolve({ ok: false, error: '未知平台：' + platform })
    const rid = String(room || '').trim()
    if (!rid) return Promise.resolve({ ok: false, error: '请填写房间号/频道名' })
    const py = path.join(this.liveDir, 'resolve.py')
    return new Promise((resolve) => {
      let stdout = ''
      let timedOut = false
      const child = spawn(this.pythonCmd, [py, platform, rid], {
        cwd: this.liveDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, 45000)
      child.stdout.on('data', (d) => { stdout += d })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, error: 'python 启动失败：' + e.message })
      })
      child.on('exit', () => {
        clearTimeout(timer)
        if (timedOut) {
          resolve({ ok: false, error: '解析超时（45s）' })
          return
        }
        // 模块会打印调试信息，取最后一行可解析的 JSON
        for (const raw of stdout.split(/\r?\n/).reverse()) {
          const line = raw.trim()
          if (!line.startsWith('{')) continue
          try {
            const obj = JSON.parse(line)
            if (typeof obj.ok === 'boolean') {
              resolve(obj)
              return
            }
          } catch { /* continue */ }
        }
        resolve({ ok: false, error: '解析器无有效输出', raw: stdout.slice(-300) })
      })
    })
  }
}

ResolverService.inject = ['config']

export default function resolverPlugin(ctx) {
  ctx.plugin(ResolverService)
}
