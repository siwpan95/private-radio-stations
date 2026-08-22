// hls plugin — slices the active relay source into HLS segments via ffmpeg,
// driven by the station lifecycle. Serves live.m3u8 + .ts into hls/<dir>.
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveSource, needsReconnect, RECONNECT_ARGS } from './streamer.js'

class HlsService extends Service {
  constructor(ctx) {
    super(ctx, 'hls')
    this.child = null
    this.dir = null
    // Wire lifecycle. Listeners don't touch ctx.config, so they are safe here.
    ctx.on('relay:start', (cur) => this.start(cur.url))
    ctx.on('relay:source', (cur) => this.start(cur.url))
    ctx.on('relay:stop', () => this.stop())
    ctx.on('dispose', () => this.stop())
  }

  get hlsDir() {
    if (!this.dir) {
      this.dir = path.resolve(this.ctx.config.root, this.ctx.config.hls.dir)
      fs.mkdirSync(this.dir, { recursive: true })
    }
    return this.dir
  }

  ffmpegOk() {
    return !!(this.ctx.config && this.ctx.config.ffmpeg)
  }

  start(url) {
    if (!url || !this.ffmpegOk()) return
    this.stop()
    const ff = this.ctx.config.ffmpeg
    const { segmentSec, listSize, variants } = this.ctx.config.hls
    resolveSource(url)
      .then((resolved) => this._spawn(ff, resolved, { segmentSec, listSize, variants }))
      .catch((e) => this.ctx.logger.warn('hls resolve failed: ' + (e && e.message)))
  }

  // 多码率 ABR：一个 ffmpeg 进程同时切出多档 AAC（默认 128k/64k），
  // live.m3u8 是 master 播放列表，指向 v_<k>.m3u8 变体列表。
  _spawn(ff, url, { segmentSec, listSize, variants }) {
    if (!url) return
    const vs = Array.isArray(variants) && variants.length ? variants : [128]
    const bitrateArgs = []
    vs.forEach((br, i) => bitrateArgs.push('-b:a:' + i, br + 'k'))
    const vmap = vs.map((br, i) => 'a:' + i + ',agroup:aud,name:' + br + 'k').join(' ')
    const args = [
      ...(needsReconnect(url) ? RECONNECT_ARGS : []),
      '-i', url,
      ...vs.flatMap(() => ['-map', '0:a']),
      '-c:a', 'aac',
      ...bitrateArgs,
      '-f', 'hls',
      '-hls_time', String(segmentSec),
      '-hls_list_size', String(listSize),
      '-hls_flags', 'delete_segments+append_list',
      '-master_pl_name', 'live.m3u8',
      '-var_stream_map', vmap,
      '-hls_segment_filename', path.join(this.hlsDir, 'seg_%v_%03d.ts'),
      path.join(this.hlsDir, 'v_%v.m3u8'),
    ]
    this.child = spawn(ff, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    this.child.on('exit', () => { if (this.child && this.child.exitCode !== null) this.child = null })
    this.ctx.logger.info('hls start (' + url + ') -> ' + this.hlsDir + '/live.m3u8 (' + vs.map((b) => b + 'k').join('/') + ')')
  }

  // 切片健康：最新分片年龄（秒）与分片数。> 2×segmentSec 说明切片卡了。
  status() {
    let latestSegAge = null
    let segments = 0
    try {
      const dir = this.hlsDir
      let newest = 0
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.ts')) {
          segments += 1
          const m = fs.statSync(path.join(dir, f)).mtimeMs
          if (m > newest) newest = m
        }
      }
      if (newest) latestSegAge = Math.round((Date.now() - newest) / 1000)
    } catch { /* ignore */ }
    return { running: !!this.child, latest_segment_age_s: latestSegAge, segments }
  }

  stop() {
    if (this.child) {
      try { this.child.kill('SIGKILL') } catch { /* ignore */ }
      this.child = null
    }
    // Remove stale segments so an idle server never serves old audio.
    try {
      const dir = this.hlsDir
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.ts') || f === 'live.m3u8' || (f.startsWith('v_') && f.endsWith('.m3u8'))) {
          fs.rmSync(path.join(dir, f), { force: true })
        }
      }
    } catch { /* ignore */ }
  }
}

HlsService.inject = ['config', 'station']

export default function hlsPlugin(ctx) {
  ctx.plugin(HlsService)
}
