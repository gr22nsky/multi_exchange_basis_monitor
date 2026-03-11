import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/client',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
