import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8720',
      '/models': 'http://127.0.0.1:8720',
      '/ws': { target: 'ws://127.0.0.1:8720', ws: true },
    },
  },
});
