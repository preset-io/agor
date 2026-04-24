#!/usr/bin/env node
/**
 * Verify the published tarball for a workspace package contains NO `workspace:`
 * protocol references in its manifest's runtime dependencies.
 *
 * Why: `npm publish` does NOT rewrite `workspace:*` references — they leak into
 * the tarball and break `npm install` for end users (npa: "Unsupported URL Type
 * 'workspace:'"). `pnpm publish` (and `pnpm pack`) resolve `workspace:*` to a
 * concrete semver range. This script runs `pnpm pack` and inspects the
 * resulting tarball, so it catches both (a) someone accidentally invoking
 * `npm publish`, and (b) any future regression in workspace resolution.
 *
 * Usage:
 *   node scripts/check-publish-artifact.mjs <package-dir> [<package-dir> ...]
 *
 * Exits 0 on success, 1 on any leaked `workspace:` reference or pack error.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const PUBLISHED_DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: check-publish-artifact.mjs <package-dir> [...]');
  process.exit(2);
}

let failed = false;

for (const rawDir of args) {
  const pkgDir = resolve(process.cwd(), rawDir);
  const sourcePkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'));
  const label = `${sourcePkg.name}@${sourcePkg.version}`;
  console.log(`\n→ Packing ${label} from ${rawDir} ...`);

  const stage = mkdtempSync(resolve(tmpdir(), 'agor-pack-'));
  try {
    // `pnpm pack` resolves `workspace:*` the same way `pnpm publish` does, so
    // inspecting its tarball gives a faithful preview of what would be
    // published.
    execFileSync('pnpm', ['pack', '--pack-destination', stage], {
      cwd: pkgDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const tgz = readdirSync(stage).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`pnpm pack produced no tarball in ${stage}`);
    const tgzPath = resolve(stage, tgz);

    // Tarball layout: <stage>/package/package.json after extraction.
    execFileSync('tar', ['-xzf', tgzPath, '-C', stage], { stdio: 'inherit' });
    const packedManifest = JSON.parse(
      readFileSync(resolve(stage, 'package', 'package.json'), 'utf8')
    );

    const violations = [];
    for (const field of PUBLISHED_DEP_FIELDS) {
      const deps = packedManifest[field];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === 'string' && spec.startsWith('workspace:')) {
          violations.push({ field, name, spec });
        }
      }
    }

    if (violations.length > 0) {
      failed = true;
      console.error(`  ✗ ${label} tarball contains unresolved workspace: refs:`);
      for (const v of violations) {
        console.error(`      ${v.field}.${v.name} = "${v.spec}"`);
      }
      console.error(
        '    Hint: publish via `pnpm publish` (NOT `npm publish`) — pnpm rewrites workspace:* at pack time.'
      );
    } else {
      console.log(`  ✓ ${label} tarball is clean (no workspace: refs).`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
