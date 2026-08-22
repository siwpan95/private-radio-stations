// Vite：面板源码在 web-src/，构建产物输出到 public/（由 node http 服务直出）。
// 开发：npm run dev:web 起 5173 热更新，/api /stream /hls 代理到 8000。
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(__dirname, 'web-src'),
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/stream': 'http://127.0.0.1:8000',
      '/hls': 'http://127.0.0.1:8000',
    },
  },
  build: {
    outDir: path.join(__dirname, 'public'),
    emptyOutDir: true,
  },
})
