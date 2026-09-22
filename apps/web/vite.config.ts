import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { parsePublicConfig } from './src/bootstrap/public-config.js';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_PUBLIC_BASE_PATH');
  const config = parsePublicConfig({
    appName: 'QAPAQ SecOps',
    basePath: environment['VITE_PUBLIC_BASE_PATH'] ?? '/',
  });
  return {
    plugins: [react()],
    base: config.basePath,
    envPrefix: [],
    define: { __QAPAQ_PUBLIC_CONFIG__: JSON.stringify(config) },
    server: { host: '127.0.0.1', strictPort: true },
    preview: { host: '127.0.0.1' },
  };
});
