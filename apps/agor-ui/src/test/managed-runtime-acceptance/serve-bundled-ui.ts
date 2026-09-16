/** Test-only production-style bundle; avoids a dev module graph across the paired TLS proxy. */
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, preview } from 'vite';
import type { ManagedAcceptanceUIOptions } from './serve-ui';

export async function serveBundledManagedAcceptanceUI(
  options: Required<ManagedAcceptanceUIOptions>
) {
  const upstream = new URL(options.runtimeOrigin);
  const publicOrigin = new URL(options.publicOrigin);
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    !upstream.port ||
    upstream.origin !== options.runtimeOrigin ||
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.origin !== options.publicOrigin ||
    publicOrigin.port ||
    !publicOrigin.hostname.endsWith('.paired.test')
  )
    throw new Error('Paired browser bundle requires synthetic HTTPS and owned loopback upstream');
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const output = await mkdtemp(join(tmpdir(), 'agor-managed-browser-bundle-'));
  try {
    await build({
      configFile: false,
      envDir: false,
      envPrefix: '__PAIRED_FIXTURE_UNUSED_',
      publicDir: false,
      root,
      logLevel: 'error',
      plugins: [react()],
      define: { global: 'globalThis' },
      resolve: { conditions: ['source'], alias: { '@': `${root}/src` } },
      build: {
        outDir: output,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { input: join(root, 'src/test/managed-runtime-acceptance/index.html') },
      },
    });
    await copyFile(
      join(output, 'src/test/managed-runtime-acceptance/index.html'),
      join(output, 'index.html')
    );
    const server = await preview({
      configFile: false,
      envDir: false,
      envPrefix: '__PAIRED_FIXTURE_UNUSED_',
      publicDir: false,
      root,
      logLevel: 'error',
      appType: 'spa',
      build: { outDir: output },
      preview: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: [publicOrigin.hostname],
        proxy: {
          '/__managed-acceptance': { target: options.runtimeOrigin, changeOrigin: false },
          '/socket.io': { target: options.runtimeOrigin, changeOrigin: false, ws: true },
        },
      },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing bundled browser listener');
    return {
      origin: `http://127.0.0.1:${address.port}`,
      async close() {
        try {
          await new Promise<void>((done, reject) =>
            server.httpServer.close((error) => (error ? reject(error) : done()))
          );
        } finally {
          await rm(output, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
