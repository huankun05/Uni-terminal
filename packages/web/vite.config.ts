import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server proxies to the headless service so the PWA is always developed
 * against the real API and the real WebSocket — the production topology (one
 * origin serving both static assets and /api + /ws) is exactly what this
 * configuration reproduces.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // 路由级代码分割（实施01 §3.1）：手机首屏不加载桌面台的管理代码。
        manualChunks(id: string) {
          if (id.includes('/routes/local/')) return 'local';
          if (id.includes('/routes/m/')) return 'mobile';
          return undefined;
        },
      },
    },
  },
});
