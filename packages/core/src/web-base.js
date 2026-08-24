// @relay/core — HTTP 面板基类（视频/音频应用共用）。
// 提供 server 生命周期（ready→start，dispose→close）与工具方法；
// 各应用子类只需实现 handle() 路由，并用静态 inject 追加自己的依赖。
import { Service } from 'cordis'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/MP2T',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// 局域网 IPv4（面板/播放链接用；没有则回退 127.0.0.1）
export function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

export class WebBase extends Service {
  constructor(ctx, name = 'web') {
    super(ctx, name)
    this.server = null
    ctx.on('ready', () => this.start())
    ctx.on('dispose', () => this.close())
  }

  async start() {
    const server = http.createServer((req, res) => this.handle(req, res))
    this.server = server
    const { port, host } = this.ctx.config
    await new Promise((resolve) => server.listen(port, host, resolve))
    this.ctx.logger.info(`control panel: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)
  }

  // P8B 服务 dispose 约定：fiber 热卸载时释放端口
  dispose() {
    this.close()
  }

  close() {
    if (this.server) {
      try { this.server.close() } catch { /* ignore */ }
      this.server = null
    }
  }

  cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  json(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  async readJson(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) }
      })
    })
  }

  serveFile(res, filePath, ext) {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end('not found')
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(data)
    })
  }

  // 子类实现路由；基类兜底 404
  async handle(req, res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

WebBase.inject = ['config']
