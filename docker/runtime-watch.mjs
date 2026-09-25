import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { prepareCheckout } from './runtime-checkout.mjs';

export function backendPort(url) {
  const path = new URL(url, 'http://localhost').pathname;
  return path === '/ui' || path.startsWith('/ui/') ? 5173 : 3031;
}

export function requiresRedeploy(paths) {
  return paths.some(
    (path) =>
      path.startsWith('docker/') ||
      path.startsWith('packages/core/drizzle/') ||
      path.includes('/migrations/') ||
      path === '.railway/railway.ts'
  );
}

export function createProxy(origin, { healthRequest = fetch } = {}) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { Location: '/ui/' });
      res.end();
      return;
    }
    if (req.url === '/health') {
      try {
        const checks = await Promise.all(
          ['/health', '/ui/'].map((path) =>
            healthRequest(`http://127.0.0.1:${backendPort(path)}${path}`, {
              signal: AbortSignal.timeout(3000),
            })
          )
        );
        const daemonHealth = await checks[0].json();
        const ready = checks.every((r) => r.ok) && daemonHealth.status === 'ok';
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        // The UI consumes identity/configuration fields from /health, not just status.
        res.end(
          JSON.stringify({ ...daemonHealth, status: ready ? 'ok' : 'starting', mode: 'watch' })
        );
      } catch {
        res.writeHead(503);
        res.end('Starting');
      }
      return;
    }
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: backendPort(req.url),
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    // Both Vite HMR and authenticated daemon sockets use the public same origin.
    if (req.headers.origin && req.headers.origin !== origin) {
      socket.destroy();
      return;
    }
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: backendPort(req.url),
      path: req.url,
      headers: req.headers,
    });
    upstream.on('upgrade', (response, remote, upstreamHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode} Switching Protocols\r\n` +
          Object.entries(response.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n'
      );
      if (head.length) remote.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(remote).pipe(socket);
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy());
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  return {
    server,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

export async function syncIfChanged({ prepare, appliedSha, changedPaths, sync }) {
  const result = await prepare();
  if (result.sha === appliedSha) return appliedSha;
  if (requiresRedeploy(await changedPaths(appliedSha, result.sha))) {
    throw new Error('Startup or migration changes require redeploy');
  }
  await sync(result.checkout);
  return result.sha;
}

export function runtimeGit(simpleGit, safeEnv) {
  return (baseDir) =>
    simpleGit({ ...(baseDir ? { baseDir } : {}), timeout: { block: 30_000 } }).env(safeEnv);
}

async function main() {
  const env = process.env;
  const origin = new URL(env.AGOR_BASE_URL).origin;
  if (!origin.startsWith('https://') || env.AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN === 'true')
    throw new Error('Remote watch requires HTTPS and secure bootstrap');
  const require = createRequire('/app/packages/git/package.json');
  const { simpleGit } = require('simple-git');
  // Do not pass operator credentials to git or source synchronization.
  const safeEnv = { PATH: env.PATH, HOME: env.HOME, GIT_TERMINAL_PROMPT: '0' };
  const git = runtimeGit(simpleGit, safeEnv);
  const options = {
    state: env.AGOR_RUNTIME_STATE,
    repo: env.AGOR_SOURCE_REPO,
    branch: env.AGOR_SOURCE_BRANCH,
    git,
    expectedFingerprint: (await readFile('/opt/agor-dependency-fingerprint', 'utf8')).trim(),
  };
  let appliedSha = env.AGOR_BUILD_SHA;
  let initialized = false;
  const proxy = createProxy(origin);
  await new Promise((resolve) => proxy.server.listen(Number(env.PORT || 3030), '0.0.0.0', resolve));
  const childEnv = {
    ...env,
    NODE_ENV: 'development',
    PORT: '3031',
    DAEMON_PORT: '3031',
    DAEMON_HOST: '127.0.0.1',
    UI_PORT: '5173',
    VITE_DAEMON_URL: origin,
    VITE_BASE_PATH: '/ui/',
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(origin).hostname,
    AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'false',
    AGOR_REMOTE_WATCH: 'true',
    SEED: 'false',
    LOAD_FIXTURES: 'false',
    CREATE_RBAC_TEST_USERS: 'false',
  };
  for (const key of ['RAILWAY_API_TOKEN', 'RAILWAY_API_KEY', 'RAILWAY_TOKEN']) delete childEnv[key];
  const child = spawn('/bin/sh', ['/app/docker/docker-entrypoint.sh'], {
    cwd: '/app',
    env: childEnv,
    stdio: 'inherit',
    detached: true,
  });
  let stopping = false;
  let timer;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    proxy.close();
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
      process.exit(code);
    }, 3000);
  }
  process.once('SIGTERM', () => stop());
  process.once('SIGINT', () => stop());
  child.once('error', () => stop(1));
  child.once('exit', () => stop(1));
  async function poll() {
    try {
      // Do not change source while the initial dependency builds are running.
      if (!initialized) {
        const health = await fetch('http://127.0.0.1:3031/health', {
          signal: AbortSignal.timeout(2000),
        });
        initialized = health.ok;
      }
      if (initialized) {
        const previous = appliedSha;
        appliedSha = await syncIfChanged({
          appliedSha,
          prepare: () => prepareCheckout(options),
          changedPaths: async (from, to) =>
            (await git(`${options.state}/checkout`).diff(['--name-only', from, to]))
              .trim()
              .split('\n'),
          sync: (checkout) =>
            new Promise((resolve, reject) => {
              const cp = spawn(
                'rsync',
                [
                  '-a',
                  '--delete',
                  '--delay-updates',
                  '--exclude=node_modules',
                  '--exclude=dist',
                  '--exclude=.turbo',
                  '--exclude=.git',
                  `${checkout}/`,
                  '/app/',
                ],
                { env: safeEnv, stdio: 'inherit' }
              );
              cp.once('error', reject);
              cp.once('exit', (code) =>
                code === 0 ? resolve() : reject(new Error('Sync failed'))
              );
            }),
        });
        if (previous !== appliedSha) console.log(`Watch source updated: ${appliedSha}`);
      }
    } catch {
      console.error(
        'Watch sync deferred: startup, fetch, dependencies or migration changes; redeploy if persistent.'
      );
    }
    if (!stopping) timer = setTimeout(poll, 10_000);
  }
  timer = setTimeout(poll, 10_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Remote watch startup failed');
    process.exitCode = 1;
  });
}
