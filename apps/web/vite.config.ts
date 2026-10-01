import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { parsePublicConfig } from './src/bootstrap/public-config.js';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), ['VITE_PUBLIC_BASE_PATH', 'VITE_API_ORIGIN']);
  // La consola y la API comparten origen en producción (mismo ingress). En desarrollo y
  // en el E2E se reproduce con un proxy, para que la cookie de sesión siga siendo
  // `SameSite=Lax` sobre un único origen y no haga falta CORS.
  const apiOrigin = environment['VITE_API_ORIGIN'] ?? 'http://127.0.0.1:3000';
  const proxy = { '/api': { target: apiOrigin, changeOrigin: false } };
  const config = parsePublicConfig({
    appName: 'QAPAQ SecOps',
    basePath: environment['VITE_PUBLIC_BASE_PATH'] ?? '/',
  });
  return {
    plugins: [react()],
    base: config.basePath,
    envPrefix: [],
    define: { __QAPAQ_PUBLIC_CONFIG__: JSON.stringify(config) },
    server: { host: '127.0.0.1', strictPort: true, proxy },
    preview: { host: '127.0.0.1', proxy },
  };
});
