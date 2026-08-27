// port.mjs — JSON-lines stdio 子进程端口（harness 层适配器）。
// 对齐 E:\lab chess-cordis/src/ports/subprocess.mjs：行分隔 JSON、按 id 关联响应、
// ready 握手、逐请求超时、stderr 抽干防死锁、dispose 时 kill 子进程（可逆效应）。
import { spawn } from 'node:child_process'
import { register, addEffect } from './registry.mjs'

export function mountPort({ id, kind = 'subprocess', cmd, args = [], cwd, timeout = 15000 }) {
  const proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  let ready = false
  let seq = 0
  const pending = new Map()

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.ready) { ready = true; continue }
      const cb = pending.get(String(msg.id))
      if (cb) { pending.delete(String(msg.id)); cb(msg) }
    }
  })
  proc.stderr.on('data', () => {}) // 抽干防死锁
  proc.stdin.on('error', () => {})
  proc.on('error', () => {})

  const call = (name, payload) => new Promise((resolve, reject) => {
    const rid = String(++seq)
    const timer = setTimeout(() => { pending.delete(rid); reject(new Error('timeout: ' + name)) }, timeout)
    pending.set(rid, (msg) => {
      clearTimeout(timer)
      if (msg.ok) resolve(msg.value)
      else reject(new Error(msg.error || name + ' failed'))
    })
    proc.stdin.write(JSON.stringify({ id: rid, cmd: name, ...payload }) + '\n')
  })

  const api = { kind, pid: proc.pid, ready: () => ready, alive: () => !proc.killed && proc.exitCode === null, call }
  register(id, api)
  addEffect(id, () => { try { proc.kill() } catch {} })
  return api
}
