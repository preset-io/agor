/**
 * Daemon Build Info Loader
 *
 * Resolves the daemon's build SHA so the UI can detect FE/BE drift after a
 * deploy. The SHA is exposed via /health and the socket "welcome" event;
 * browser tabs capture it on first connect and prompt a refresh whenever a
 * subsequent handshake reports a different SHA.
 *
 * Precedence (first match wins):
 *   1. process.env.AGOR_BUILD_SHA           — Docker --build-arg, CI
 *   2. <daemon-dist>/.build-info            — written by packages/agor-live/build.sh
 *   3. git rev-parse --short HEAD           — local source installs
 *   4. 'dev'                                — disables the version check entirely
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  sha: string;
  builtAt: string | null;
  /** Where the SHA came from — useful for /health debugging and the CLI. */
  source: 'env' | 'file' | 'git' | 'fallback';
}

const FALLBACK_SHA = 'dev';

/**
 * Resolve the daemon's build SHA + builtAt timestamp.
 *
 * Pure function — no app dependency. Synchronous so it can be cached at
 * module load like loadDaemonVersion().
 *
 * @param importMetaUrl - Pass `import.meta.url` so we can locate the dist dir.
 */
export function loadBuildInfo(importMetaUrl: string): BuildInfo {
  // 1. Env wins — set by Docker --build-arg or CI.
  const envSha = process.env.AGOR_BUILD_SHA?.trim();
  if (envSha) {
    return {
      sha: envSha,
      builtAt: process.env.AGOR_BUILT_AT?.trim() || null,
      source: 'env',
    };
  }

  // 2. .build-info file written by packages/agor-live/build.sh into the
  //    daemon dist. The file sits next to the entry point; try both common
  //    layouts (src/setup/ in dev, dist/ root in agor-live).
  const currentDir = dirname(fileURLToPath(importMetaUrl));
  const candidates = [join(currentDir, '../.build-info'), join(currentDir, '../../.build-info')];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as { sha?: unknown; builtAt?: unknown };
      if (typeof parsed.sha === 'string' && parsed.sha) {
        return {
          sha: parsed.sha,
          builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null,
          source: 'file',
        };
      }
    } catch {
      // Try next path
    }
  }

  // 3. git rev-parse for local source installs. Use execFileSync (not exec)
  //    so the path is never interpreted as a shell argument.
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: currentDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (sha) {
      return { sha, builtAt: null, source: 'git' };
    }
  } catch {
    // Not a git checkout, or git not installed
  }

  // 4. Fallback. The literal string 'dev' is special: the UI treats it as
  //    "no version check" — handy for source-mode contributors hot-reloading
  //    the daemon, where the SHA would otherwise change on every commit.
  return { sha: FALLBACK_SHA, builtAt: null, source: 'fallback' };
}

/**
 * True when version-sync banner should be disabled. The UI also short-circuits
 * on this string, but keeping the helper close to the loader documents the
 * contract on both sides.
 */
export function isDevSha(sha: string | null | undefined): boolean {
  return !sha || sha === FALLBACK_SHA;
}
