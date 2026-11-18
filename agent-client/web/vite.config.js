import { defineConfig } from 'vite';

// 仅 Vite 开发服务器使用：允许把 /api 代理到非默认端口，
// 便于在同一台机器上与已占用 3000 的实例并存。
const apiTarget = process.env.BIOFLOW_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
