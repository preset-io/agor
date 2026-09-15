/** Disposable browser-test server. No production routes/configuration are changed. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

export interface ManagedAcceptanceUIOptions {
  /** Disposable loopback daemon only. Never point this fixture at a deployed runtime. */
  runtimeOrigin?: string;
  /** Exact browser origin forwarded by the paired fixture's generated-CA TLS listener. */
  publicOrigin?: string;
}

export async function serveManagedAcceptanceUI({
  runtimeOrigin,
  publicOrigin,
}: ManagedAcceptanceUIOptions = {}) {
  if (runtimeOrigin) {
    const target = new URL(runtimeOrigin);
    if (
      target.protocol !== 'http:' ||
      target.hostname !== '127.0.0.1' ||
      !target.port ||
      target.origin !== runtimeOrigin
    )
      throw new Error('Acceptance upstream must be a disposable loopback listener');
  }
  let publicHost: string | undefined;
  if (publicOrigin) {
    const target = new URL(publicOrigin);
    if (
      target.protocol !== 'https:' ||
      target.port !== '' ||
      target.origin !== publicOrigin ||
      !(target.hostname.endsWith('.example') || target.hostname.endsWith('.paired.test'))
    )
      throw new Error('Acceptance browser origin must be a canonical synthetic HTTPS origin');
    publicHost = target.hostname;
  }
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
      ...(publicHost ? { allowedHosts: [publicHost] } : {}),
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
