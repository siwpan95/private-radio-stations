// portal — 统一门户静态服务（:9000）：零依赖，纯 Node http。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(__dirname, '..', 'public')
const port = Number(process.env.PORT) || 9000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/api/status' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ version: '1.0.0', uptime: Math.round(process.uptime()), backends: { video: 8100, audio: 8000 } }))
  }
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    const remote = req.socket.remoteAddress || ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!loopback) { res.writeHead(403); return res.end('forbidden') }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
    return setTimeout(() => process.exit(0), 150)
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname
  const fp = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    return res.end('not found')
  }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream')
  fs.createReadStream(fp).pipe(res)
})

server.listen(port, '0.0.0.0', () => {
  console.log('[portal] http://localhost:' + port)
})
