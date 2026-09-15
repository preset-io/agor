/** Disposable browser-test server. No production routes/configuration are changed. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

export async function serveManagedAcceptanceUI(runtimeOrigin?: string) {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    resolve: { conditions: ['source'], alias: { '@': `${root}/src` } },
    optimizeDeps: { include: ['antd/es/color-picker/color'] },
    server: {
      host: '127.0.0.1',
      port: 0,
      ...(runtimeOrigin
        ? {
            proxy: {
              '/__managed-acceptance': { target: runtimeOrigin, changeOrigin: false },
              '/socket.io': { target: runtimeOrigin, changeOrigin: false, ws: true },
            },
          }
        : {}),
    },
    plugins: [
      react(),
      {
        name: 'managed-acceptance-entry',
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
            if (!runtimeOrigin && path === '/__managed-acceptance/session') {
              response.writeHead(401, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ error: 'paired_runtime_required' }));
              return;
            }
            if (!/^\/(?:ui\/)?(?:mcp-oauth\/complete\/?)?$/.test(path)) {
              next();
              return;
            }
            try {
              response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
              response.end(await vite.transformIndexHtml(path, html));
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('Missing acceptance listener');
  }
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}
