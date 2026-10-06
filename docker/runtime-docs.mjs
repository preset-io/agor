import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dependencyFingerprint, prepareCheckout } from './runtime-checkout.mjs';
import { runtimeGit, syncIfChanged } from './runtime-watch.mjs';

export const docsFingerprint = (root) =>
  dependencyFingerprint(root, ['apps/agor-docs', 'packages/git']);

export function docsRequiresRedeploy(paths) {
  return paths.some(
    (path) =>
      path.startsWith('docker/') ||
      path.startsWith('apps/agor-docs/scripts/') ||
      /^apps\/agor-docs\/(next\.config\.|tsconfig\.)/.test(path)
  );
}

// Copy only docs source; preserve the image's frozen dependencies and Next's
// running compiler state. Never copy .git, local secrets or generated exports.
export function docsSyncArgs(checkout, destination = '/app/apps/agor-docs/') {
  return [
    '-a',
    '--delete',
    '--delay-updates',
    '--exclude=node_modules',
    '--exclude=.next*',
    '--exclude=out',
    '--exclude=.git',
    '--exclude=.env*',
    '--exclude=*.tsbuildinfo',
    '--exclude=public/_pagefind',
    `${checkout}/apps/agor-docs/`,
    destination,
  ];
}

export function docsEnvironment(env) {
  const origin = new URL(env.AGOR_DOCS_PREVIEW_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.AGOR_DOCS_PREVIEW_ORIGIN)
    throw new Error('Docs preview requires an HTTPS origin');
  const port = env.PORT || '3030';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('Invalid docs preview port');
  // Explicit allowlist: neither Railway provisioning tokens nor SQLite admin
  // credentials belong in the Next server, its compiler or browser bundles.
  return {
    PATH: env.PATH,
    HOME: '/home/agor',
    NODE_ENV: 'development',
    PORT: port,
    NEXT_PUBLIC_SITE_URL: origin.origin,
    AGOR_DOCS_PREVIEW_ORIGIN: origin.origin,
    NEXT_TELEMETRY_DISABLED: '1',
    // Nextra's real homepage compiles the docs page map, not just one route.
    // 2 GiB makes Next repeatedly restart; leave headroom within the 8 GiB container.
    NODE_OPTIONS: '--max-old-space-size=4096',
  };
}

function command(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Command failed'))));
  });
}

async function main(args) {
  if (args.length === 1 && args[0] === 'fingerprint') {
    console.log(await docsFingerprint('/app'));
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--watch'))
    throw new Error('Use --watch to follow the pushed branch');
  const env = process.env;
  const childEnv = docsEnvironment(env);
  const require = createRequire('/app/packages/git/package.json');
  const { simpleGit } = require('simple-git');
  const safeEnv = { PATH: env.PATH, HOME: childEnv.HOME, GIT_TERMINAL_PROMPT: '0' };
  const git = runtimeGit(simpleGit, safeEnv);
  const options = {
    state: '/home/agor/.agor/runtime-docs',
    repo: env.AGOR_SOURCE_REPO,
    branch: env.AGOR_SOURCE_BRANCH,
    git,
    fingerprint: docsFingerprint,
    expectedFingerprint: (await readFile('/opt/agor-docs-fingerprint', 'utf8')).trim(),
  };
  const sync = (checkout) => command('rsync', docsSyncArgs(checkout), safeEnv);
  const initial = await prepareCheckout(options);
  await sync(initial.checkout);
  let appliedSha = initial.sha;
  console.log(`Docs source commit: ${appliedSha}`);
  const child = spawn(
    '/app/apps/agor-docs/node_modules/.bin/next',
    ['dev', '-H', '0.0.0.0', '-p', childEnv.PORT],
    {
      cwd: '/app/apps/agor-docs',
      env: childEnv,
      stdio: 'inherit',
      detached: true,
    }
  );
  let stopping = false;
  let timer;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        /* already exited */
      }
    };
    signal('SIGTERM');
    setTimeout(() => {
      signal('SIGKILL');
      process.exit(code);
    }, 3000);
  }
  process.once('SIGTERM', () => stop());
  process.once('SIGINT', () => stop());
  child.once('error', () => stop(1));
  child.once('exit', () => stop(1));
  async function poll() {
    try {
      const previous = appliedSha;
      appliedSha = await syncIfChanged({
        appliedSha,
        prepare: () => prepareCheckout(options),
        changedPaths: async (from, to) =>
          (await git(`${options.state}/checkout`).diff(['--name-only', from, to]))
            .trim()
            .split('\n'),
        needsRedeploy: docsRequiresRedeploy,
        sync: async (checkout) => {
          if (!stopping) await sync(checkout);
        },
      });
      if (previous !== appliedSha) console.log(`Docs source updated: ${appliedSha}`);
    } catch {
      // Keep serving the last applied source; do not install packages, replace
      // the runtime or echo git/provider credentials from an error message.
      console.error(
        'Docs sync deferred: fetch, ownership, dependencies or startup changed; Stop/Start if persistent.'
      );
    }
    if (!stopping) timer = setTimeout(poll, 10_000);
  }
  if (args[0] === '--watch') timer = setTimeout(poll, 10_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Docs preview startup failed (source, ownership, dependencies or configuration).'
    );
    process.exitCode = 1;
  });
}
