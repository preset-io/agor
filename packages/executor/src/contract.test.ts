/**
 * Source-level contract tests for the executor.
 *
 * The executor MUST NOT read `~/.agor/config.yaml` directly. Everything it
 * needs comes from (a) env vars set by the daemon at spawn time, or
 * (b) the `resolvedConfig` slice on the payload. See
 * context/explorations/daemon-fs-decoupling.md §1.5 (H1) for the rationale,
 * and `packages/executor/src/config.ts` for the local getDaemonUrl() that
 * replaces the previous core re-export.
 *
 * Source scans (rather than runtime asserts) catch regressions before they
 * ship — the file `getDaemonUrl` re-export used to sit in config.ts and
 * was reachable via `await getDaemonUrl()` in 5 SDK handlers without anyone
 * noticing. Pin it here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile()) {
      // Skip tests — they may legitimately import core helpers to verify shape.
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

const sources = listSourceFiles(here);

describe('executor source contract', () => {
  it('does not import getDaemonUrl from @agor/core (must use the executor-local env-only version)', () => {
    const offenders: string[] = [];
    // Match: `import { ..., getDaemonUrl, ... } from '@agor/core...'`
    const pattern = /from\s+['"]@agor\/core(?:\/[^'"]+)?['"]/;
    for (const file of sources) {
      const content = readFileSync(file, 'utf-8');
      // Pull every `@agor/core` import statement and check its specifier list.
      const importMatches = content.matchAll(
        /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]@agor\/core(?:\/[^'"]+)?['"]/g
      );
      for (const m of importMatches) {
        const specifiers = m[1] as string;
        if (/\bgetDaemonUrl\b/.test(specifiers)) {
          offenders.push(`${file}: ${m[0]}`);
        }
      }
      // Also catch `import * as X from '@agor/core...'` patterns indirectly —
      // a `X.getDaemonUrl(` call wouldn't be visible to the destructuring
      // scan above. Cheap text search.
      if (pattern.test(content) && /\.getDaemonUrl\s*\(/.test(content)) {
        offenders.push(`${file}: namespaced .getDaemonUrl() call`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not import loadConfig or loadConfigSync from @agor/core', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const content = readFileSync(file, 'utf-8');
      const importMatches = content.matchAll(
        /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]@agor\/core(?:\/[^'"]+)?['"]/g
      );
      for (const m of importMatches) {
        const specifiers = m[1] as string;
        if (/\b(loadConfig|loadConfigSync|loadConfigFromFile)\b/.test(specifiers)) {
          offenders.push(`${file}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('executor-local getDaemonUrl reads only DAEMON_URL and throws when unset', () => {
    const configSrc = readFileSync(join(here, 'config.ts'), 'utf-8');
    // Affirmative shape — guards against someone re-introducing a config.yaml fallback.
    expect(configSrc).toMatch(/process\.env\.DAEMON_URL/);
    // No loadConfig escape hatch.
    expect(configSrc).not.toMatch(/\bloadConfig\b/);
  });
});
