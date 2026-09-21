import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: {
      '/api': {
        target: mode === 'test' ? 'http://127.0.0.1:3100' : 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
}));
