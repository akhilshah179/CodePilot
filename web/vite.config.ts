import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      // The API (including OAuth callbacks and SSE) is served by the CodePilot server.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: { target: 'es2022', sourcemap: process.env.NODE_ENV !== 'production' },
});
