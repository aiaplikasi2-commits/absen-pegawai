import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      {
        name: 'resilient-vite-ws-client',
        enforce: 'post',
        transform(code, id) {
          if (!id.includes('vite/dist/client/client.mjs')) return null;
          let patched = code
            .replace(
              ':${hmrPort || importMetaUrl.port}',
              '${(hmrPort || importMetaUrl.port) ? ":" + (hmrPort || importMetaUrl.port) : ""}'
            )
            .replace(
              'ws.send(JSON.stringify(data));',
              'if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));'
            );
          if (process.env.DISABLE_HMR === 'true') {
            patched = patched
              .replace(
                /transport\.connect\(createHMRHandler\(handleMessage\)\);/g,
                'transport.connect(createHMRHandler(handleMessage)).catch(() => {});'
              )
              .replace(
                /try \{\s*await wsTransport\.connect\(handlers\);\s*\} catch \(e\) \{[\s\S]*?throw e;\s*\}/,
                'try { await wsTransport.connect(handlers); } catch { return; }'
              );
          }
          return patched;
        },
      },
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png'],
        manifest: {
          id: '/',
          name: 'ABSENSI WAJAH & GPS',
          short_name: 'AbsensiGPS',
          description: 'Aplikasi absensi online & offline berbasis verifikasi wajah biometrik, liveness detection, dan validasi radius GPS.',
          theme_color: '#0F2942',
          background_color: '#F8FAFC',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'mediapipe-wasm-cache',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 90,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/storage\.googleapis\.com\/mediapipe-models\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'mediapipe-model-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 90,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
