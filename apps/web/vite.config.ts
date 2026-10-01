import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { parsePublicConfig } from './src/bootstrap/public-config.js';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), ['VITE_PUBLIC_BASE_PATH', 'VITE_API_ORIGIN']);
  // La consola y la API comparten origen en producción (mismo ingress). En desarrollo y
  // en el E2E se reproduce con un proxy, para que la cookie de sesión siga siendo
  // `SameSite=Lax` sobre un único origen y no haga falta CORS.
  const apiOrigin = environment['VITE_API_ORIGIN'] ?? 'http://127.0.0.1:3000';
  const proxy = {
    '/api': {
      target: apiOrigin,
      changeOrigin: false,
      rewrite: (path: string) =>
        path.startsWith('/api/health') ? path.replace(/^\/api/u, '') : path,
    },
  };
  const config = parsePublicConfig({
    appName: 'QAPAQ SecOps',
    basePath: environment['VITE_PUBLIC_BASE_PATH'] ?? '/',
  });
  return {
    plugins: [react(), tailwindcss()],
    base: config.basePath,
    envPrefix: [],
    define: { __QAPAQ_PUBLIC_CONFIG__: JSON.stringify(config) },
    // Dos páginas: el producto en `/` y la consola operativa de C-21 en `/console.html`.
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'index.html'),
          console: resolve(import.meta.dirname, 'console.html'),
        },
      },
    },
    // Un solo proxy para los dos consumidores de la consola:
    //
    // - `/api/health/*` pierde el prefijo porque el health de C-02 vive en `/health`;
    // - el resto pasa tal cual, porque el BFF de C-18 publica sus rutas bajo `/api`.
    //
    // Mismo origen en ambos casos: la cookie de sesion sigue siendo SameSite=Lax y no
    // hace falta CORS.
    server: { host: '127.0.0.1', strictPort: true, proxy },
    preview: { host: '127.0.0.1', proxy },
  };
});
