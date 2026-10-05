// CI-only container smoke: no Railway API, remote Git, forms or browser analytics.
// /source is the read-only PR checkout; /app and /tmp are disposable container storage.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { docsEnvironment, docsSyncArgs } from '/usr/local/lib/agor/runtime-docs.mjs';

const source = await mkdtemp('/tmp/docs-smoke-');
await mkdir(`${source}/apps`, { recursive: true });
await cp('/source/apps/agor-docs', `${source}/apps/agor-docs`, { recursive: true });
const route = `${source}/apps/agor-docs/app/preview-runtime-smoke/page.tsx`;
await mkdir(route.slice(0, route.lastIndexOf('/')), { recursive: true });
const env = docsEnvironment({
  PATH: process.env.PATH,
  AGOR_DOCS_PREVIEW_ORIGIN: 'https://preview.example',
});
async function sync(text) {
  await writeFile(route, `export default function Page() { return <h1>${text}</h1>; }\n`);
  await new Promise((resolve, reject) => {
    const child = spawn('rsync', docsSyncArgs(source), { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Sync failed'))));
  });
}
await sync('docs-preview-before');
const child = spawn(
  '/app/apps/agor-docs/node_modules/.bin/next',
  ['dev', '-H', '0.0.0.0', '-p', env.PORT],
  {
    cwd: '/app/apps/agor-docs',
    env,
    stdio: 'inherit',
    detached: true,
  }
);
const exited = new Promise((resolve) => child.once('exit', resolve));
child.once('error', (error) => {
  throw error;
});
async function expectText(text) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:3030/preview-runtime-smoke', {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok && (await response.text()).includes(`<h1>${text}</h1>`)) return;
    } catch {
      /* initial compilation */
    }
    if (child.exitCode !== null) throw new Error('Next exited before readiness');
    await delay(1000);
  }
  assert.fail(`Docs preview did not render ${text}`);
}
try {
  await expectText('docs-preview-before');
  await sync('docs-preview-after');
  await expectText('docs-preview-after');
  console.log('Docs image serves source updates without a server restart.');
} finally {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already exited */
  }
  await Promise.race([exited, delay(3000)]);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already exited */
  }
}
