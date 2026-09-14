// @relay/audio — musickit 随机渲染音源插件（musickit S4，2026-08-25）
// 自 python musickit_source.py 迁移：渲染子进程队列 + 状态 + 缓存清理（子进程隔离）。
// 与 python 版 API 契约一致：POST /api/musickit {action:start|stop, channel?, bars?}；
// GET /api/status 的 musickit 字段（web.js 聚合）。
import { Service } from 'cordis'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

class MusickitService extends Service {
  // 行配置此前根本没生效：插件函数把 config 丢了，而 cfg 读的是 ctx.config.musickit
  // （config 行的 schema 里并没有这个键）→ cordis.yml / cordis.patch.yml 里 musickit
  // 行的配置全部被忽略，只能用硬编码兜底值。与 monitor.js 对齐：行配置进构造器，
  // 为空时回退到 config 服务的 musickit 段（兼容旧写法与单测的 FakeConfig）。
  constructor(ctx, cfg = {}) {
    super(ctx, 'musickit')
    this._rowCfg = cfg || {}
    this.started = false
    this.rendering = false
    this.channel = this.cfg.channel || 'random'
    this.bars = Number(this.cfg.bars || 32)
    this.renderedCount = 0
    this.lastError = ''
    this.queue = []
    this.current = null
    this._files = []
    this._timer = null
    this._fails = 0
  }

  get cfg() {
    if (this._rowCfg && Object.keys(this._rowCfg).length) return this._rowCfg
    return (this.ctx.config && this.ctx.config.musickit) || {}
  }

  get root() {
    return this.cfg.root || 'G:\\music\\musickit'
  }

  rendererPath() {
    return this.cfg.renderer || path.join(this.root, 'remix', 'tools', 'musickit_render_one.py')
  }

  cacheDir() {
    return this.cfg.cacheDir || path.join(this.root, 'radio', 'render_cache')
  }

  python() {
    return this.cfg.python || 'python'
  }

  // ---- 生命周期（对齐 python 版语义：已启动则仅更新参数） ----
  start(channel, bars) {
    if (channel) this.channel = channel
    if (bars !== undefined) this.bars = Number(bars)
    this.started = true
    if (this._timer) return
    this._timer = setInterval(() => { if (this.started) this._tick() }, 250)
  }

  stop() {
    this.started = false
    this.queue = []
    this.current = null
    this._fails = 0
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  setParams(channel, bars) {
    if (channel) this.channel = channel
    if (bars !== undefined) this.bars = Number(bars)
  }

  status() {
    return {
      active: this.started,
      rendering: this.rendering,
      channel: this.channel,
      bars: this.bars,
      queued: this.queue.length,
      rendered_count: this.renderedCount,
      last_error: this.lastError,
      cache_dir: this.cacheDir(),
      current: this.current ? this.current.title : '',
    }
  }

  // ---- 渲染（子进程隔离） ----
  async _renderOne() {
    const script = this.rendererPath()
    if (!fs.existsSync(script)) {
      this.lastError = '找不到渲染器: ' + script
      return null
    }
    const args = [
      script,
      '--channel', this.channel || 'random',
      '--bars', String(this.bars),
      '--format', this.cfg.format || 'mp3',
      '--out', this.cacheDir(),
      '--max-tracks', String(this.cfg.maxTracks || 5),
    ]
    if (this.cfg.fusion) args.push('--fusion')
    if (this.cfg.releaseSafe) args.push('--release-safe')
    const timeout = Number(this.cfg.timeoutSec || 600) * 1000
    return new Promise((resolve) => {
      const child = spawn(this.python(), args, {
        cwd: this.root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => { child.kill(); this.lastError = '渲染超时(>' + (timeout / 1000) + 's)'; resolve(null) }, timeout)
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      child.on('error', (e) => { clearTimeout(timer); this.lastError = String(e.message); resolve(null) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) { this.lastError = '渲染器退出码 ' + code + (err ? ': ' + err.slice(-200) : ''); return resolve(null) }
        const lines = out.trim().split(/\r?\n/)
        try {
          const data = JSON.parse(lines[lines.length - 1])
          if (!data.ok || !data.file || !fs.existsSync(data.file)) {
            this.lastError = data.error || '渲染器返回无效结果'
            return resolve(null)
          }
          const parts = [data.style, data.label, data.subgenre].filter(Boolean)
          if (data.bpm) parts.push(data.bpm + ' BPM')
          data.title = '随机渲染：' + (parts.join(' · ') || path.basename(data.file))
          this.lastError = ''
          resolve(data)
        } catch {
          this.lastError = '渲染器输出解析失败'
          resolve(null)
        }
      })
    })
  }

  async _tick() {
    if (!this.started || this.rendering) return
    this.rendering = true
    const meta = await this._renderOne()
    this.rendering = false
    if (meta === null) {
      this._fails += 1
      if (this._fails >= Number(this.cfg.maxFails || 5)) {
        this.lastError = '连续渲染失败，已放弃重试（检查引擎依赖/素材池）'
        this.stop()
      }
      return
    }
    this._fails = 0
    this.renderedCount += 1
    this._files.push(meta.file)
    const depth = Number(this.cfg.queueDepth || 3)
    if (this.queue.length >= depth) this.queue.shift()
    this.queue.push(meta)
    this._prune()
  }

  _prune() {
    const keep = Number(this.cfg.keep || 20)
    const files = [...this._files]
    if (files.length <= keep) return
    for (const p of files.slice(0, files.length - keep)) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch { /* 忽略 */ }
    }
    this._files = files.slice(files.length - keep)
  }

  // ---- 取曲接口（对齐 python 版） ----
  advance() {
    const meta = this.queue.shift() || null
    if (meta) this.current = meta
    return meta
  }

  currentPath() {
    return this.current ? this.current.file : null
  }

  currentTitle() {
    return this.current ? this.current.title : ''
  }
}

MusickitService.inject = ['config']

export default function musickitPlugin(ctx, cfg = {}) {
  ctx.plugin(MusickitService, cfg)
}
