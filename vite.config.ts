import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3762', changeOrigin: false },
      '/assets': { target: 'http://127.0.0.1:3762', changeOrigin: false },
      '/mcp': { target: 'http://127.0.0.1:3762', changeOrigin: false },
    },
  },
});
