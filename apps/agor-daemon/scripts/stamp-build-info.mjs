#!/usr/bin/env node
/**
 * Stamp dist/.build-info with the current build SHA + timestamp.
 *
 * Runs as part of `pnpm --filter @agor/daemon build` (see package.json
 * `build` script). This is the canonical place that produces .build-info —
 * packages/agor-live/build.sh no longer writes it; it just `cp -r`s the
 * daemon's dist (which now includes the file).
 *
 * Resolution mirrors loadBuildInfo() (build-info.ts) but in shell-friendly
 * order:
 *   1. AGOR_BUILD_SHA env (CI / Docker --build-arg)
 *   2. git rev-parse --short HEAD
 *   3. (none) — skip writing the file entirely
 *
 * IMPORTANT: when neither env nor git produces a SHA we DO NOT write a
 * placeholder. loadBuildInfo() treats any non-empty `.build-info` SHA as
 * authoritative (see build-info.ts:58), so writing 'unknown' would lock the
 * daemon to a fake concrete SHA that can never match anything else and
 * would falsely trigger the out-of-sync banner on every redeploy. By not
 * writing the file, loadBuildInfo's own fallback chain runs at startup —
 * its own runtime git attempt, then the 'dev' sentinel which disables the
 * version check entirely. Both are safer than a poisoned baseline.
 *
 * This file is what loadBuildInfo()'s "file" precedence step (#2) reads at
 * daemon startup. The runtime git fallback (#3 in loadBuildInfo) still
 * exists for source-mode dev where this script may not have run recently.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(scriptDir, '..', 'dist');
const outPath = join(distDir, '.build-info');

function resolveSha() {
  const envSha = process.env.AGOR_BUILD_SHA?.trim();
  if (envSha) return { sha: envSha, source: 'env' };
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: scriptDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (sha) return { sha, source: 'git' };
  } catch {
    // Not a git checkout, or git not installed
  }
  return { sha: null, source: 'fallback' };
}

const { sha, source } = resolveSha();

if (sha === null) {
  // Intentional: see header comment. Better to skip the file than poison
  // loadBuildInfo()'s file-step with a bogus 'unknown' SHA.
  console.log(
    `  .build-info: skipped (no SHA available; loadBuildInfo will fall through to git/dev)`
  );
} else {
  const builtAt = process.env.AGOR_BUILT_AT?.trim() || new Date().toISOString();
  mkdirSync(distDir, { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ sha, builtAt })}\n`);
  console.log(`  .build-info: sha=${sha} builtAt=${builtAt} (source=${source})`);
}
