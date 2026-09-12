import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Dev server proxies to the headless service so the PWA is always developed
 * against the real API and the real WebSocket — the production topology (one
 * origin serving both static assets and /api + /ws) is exactly what this
 * configuration reproduces.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 自动更新：新版本在下次刷新即生效。'prompt' 模式需要界面配合，
      // 没做提示界面会让用户永远停留在旧版本——这里宁可简单可靠。
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'Uni-terminal',
        short_name: 'Uni-terminal',
        description: '扫码即用的自托管 AI 编程代理控制台',
        lang: 'zh-CN',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0b0f16',
        background_color: '#0b0f16',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 两条硬规则（实施01 §3.7）：绝不缓存 /api/* 与 /ws——
        // 缓存的接口响应就是"过期状态"，比没有网更危险。
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
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
