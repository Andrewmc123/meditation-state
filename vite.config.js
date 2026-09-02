import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },
  // 8K JPEGs live in public/ and are copied verbatim - never inline them.
  assetsInclude: ['**/*.bin'],
});
