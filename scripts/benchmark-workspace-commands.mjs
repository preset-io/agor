#!/usr/bin/env node
// Run in disposable workspaces only. Baseline and replica must live on the same local filesystem.
import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [baseline, replica, output] = process.argv.slice(2);
if (!baseline || !replica || !output || baseline === replica)
  throw new Error(
    'Usage: node benchmark-workspace-commands.mjs BASELINE_DIR REPLICA_DIR OUTPUT_JSON'
  );
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone benchmark, never a cached Turbo task
const selectedCommands = process.env.AGOR_WORKSPACE_BENCH_COMMANDS?.split(',');
const results = [];
for (const [name, args] of [
  ['install', ['install', '--frozen-lockfile']],
  ['typecheck', ['typecheck']],
  ['build', ['build']],
]) {
  if (selectedCommands && !selectedCommands.includes(name)) continue;
  for (const warmth of ['cold', 'warm'])
    for (const [kind, cwd] of [
      ['baseline', baseline],
      ['replica', replica],
    ]) {
      // Cold is disposable local application/package cache, not a claim of dropping the OS page cache.
      if (warmth === 'cold')
        for (const entry of ['.turbo', ...(name === 'install' ? ['node_modules'] : [])])
          await rm(path.join(cwd, entry), { recursive: true, force: true });
      const start = performance.now();
      const outcome = await new Promise((resolve) => {
        const child = spawn('pnpm', args, {
          cwd,
          env: { ...process.env, CI: 'true' },
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60 * 1000);
        child.once('error', (error) => {
          clearTimeout(timer);
          resolve({ error: error.message });
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      results.push({ name, warmth, kind, ms: performance.now() - start, ...outcome });
      await writeFile(
        output,
        JSON.stringify(
          {
            schema: 1,
            trials: results,
            coldDefinition: 'local application caches cleared; OS cache not flushed',
          },
          null,
          2
        )
      );
    }
}
for (const name of selectedCommands ?? ['install', 'typecheck', 'build'])
  for (const warmth of ['cold', 'warm']) {
    const pair = results.filter((r) => r.name === name && r.warmth === warmth);
    console.log(
      `${name} ${warmth}: ${pair.every((r) => r.code === 0) ? `${(pair[1].ms / pair[0].ms).toFixed(3)}x baseline` : 'FAILED: inspect raw results'}`
    );
  }
