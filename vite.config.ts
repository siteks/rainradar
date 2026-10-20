/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const RADAR_HOST = String.raw`https:\/\/met-office-radar-obs-data\.s3\.eu-west-2\.amazonaws\.com`;

export default defineConfig({
  // Relative base so the same build works at https://<user>.github.io/<repo>/ and on localhost.
  base: './',
  worker: { format: 'es' },
  // MapLibre alone is ~1 MB; it is precached by the service worker, so the default 500 kB warning is noise.
  build: { chunkSizeWarningLimit: 1200 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'RainRadar',
        short_name: 'RainRadar',
        description: 'UK rain radar with a time slider and short-range forecast',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b2a4a',
        theme_color: '#0b2a4a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // Radar frames have one immutable URL per timestamp.
            urlPattern: new RegExp(`^${RADAR_HOST}/radar/.*\\.h5$`),
            handler: 'CacheFirst',
            options: {
              cacheName: 'radar-frames',
              expiration: { maxEntries: 24, maxAgeSeconds: 6 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: new RegExp(`^${RADAR_HOST}/\\?list-type=2`),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'radar-index',
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 4 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'basemap',
              expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
  },
});
