import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // PORT lets a second dev instance (e.g. a preview harness) pick its own port
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8720',
      '/models': 'http://127.0.0.1:8720',
      '/ws': { target: 'ws://127.0.0.1:8720', ws: true },
    },
  },
});
