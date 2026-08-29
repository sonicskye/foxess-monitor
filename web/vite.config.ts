import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The target is a Celeron laptop, so keep the bundle small and skip the extra gzip pass.
    target: 'es2020',
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    proxy: {
      // Dev server talks to the real backend, which holds the API key.
      '/api': { target: 'http://localhost:8080', changeOrigin: true, ws: false },
      '/healthz': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
