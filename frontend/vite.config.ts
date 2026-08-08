import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 后端 Fastify 服务：backend/src/config.ts → PORT ?? 8080
// 代理所有 /api 与 /health 请求到后端，前端代码一律使用相对路径（如 /api/v1/...）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
