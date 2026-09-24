/**
 * Every `@agor/core` export-map entry, imported by plain Node from `dist`.
 *
 * tsup keeps dependencies external, so a built entry carries its source's
 * `import { x } from 'some-cjs-package'` through verbatim. Node resolves a
 * CommonJS package's named exports with a static lexer; a name the lexer
 * cannot see (`retryPolicies` from `@slack/web-api`, for one) fails at LINK
 * time with `SyntaxError: Named export 'x' not found` — before any code in the
 * entry runs, so the daemon never boots. Vitest resolves `@agor/core` to
 * source and does its own CJS interop, so no unit test can observe this; it
 * reached the Docker image smoke boot with the whole suite green.
 *
 * So this imports each entry through the package's own `exports` (the
 * `source` condition is not set here, so Node picks `import` → `dist`),
 * exactly as a daemon does. It checks linking and top-level evaluation, not
 * behaviour. A new CJS dependency should be imported by default and
 * destructured (see `retryPolicies` in `gateway/connectors/slack.ts`).
 *
 * Run after `pnpm --filter @agor/core build`; CI runs it in the build lane
 * via `test:packaged`.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Export-map entries whose `import` target tsup does not emit. Only the UI
 * consumes them, through the `source` condition, so nothing loads their dist
 * path today. Named here rather than skipped by "file is missing", so a newly
 * missing entry still fails — and a listed one that starts building fails
 * too, so this list cannot outlive the defect it records.
 */
const UNBUILT_ENTRIES = new Set([
  './design/board-backgrounds', // not a tsup entry
  './seed/dev-fixtures', // not a tsup entry
  './seed/demo-fixtures', // not a tsup entry
  './gateway/discord-setup', // tsup emits dist/gateway/discord-setup.js, not connectors/
]);

const failures = [];
const entries = Object.entries(pkg.exports).filter(
  ([, target]) => typeof target === 'object' && target.import
);
const specifiers = [];
for (const [subpath, target] of entries) {
  const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
  if (!UNBUILT_ENTRIES.has(subpath)) {
    specifiers.push(specifier);
  } else if (existsSync(new URL(`../${target.import}`, import.meta.url))) {
    failures.push({
      specifier,
      error: `${target.import} now exists; remove ${subpath} from UNBUILT_ENTRIES`,
    });
  }
}

if (specifiers.length === 0) {
  throw new Error(`No importable entries found in ${pkg.name} exports`);
}

for (const specifier of specifiers) {
  try {
    await import(specifier);
  } catch (error) {
    failures.push({ specifier, error });
  }
}

if (failures.length > 0) {
  for (const { specifier, error } of failures) {
    console.error(`[core] ${specifier} failed to import under Node:\n  ${error?.stack ?? error}\n`);
  }
  console.error(`[core] ${failures.length}/${specifiers.length} packaged entries failed to import`);
  process.exit(1);
}

console.log(`[core] packaged entry import smoke ok (${specifiers.length} entries)`);
// Some entries start timers or open handles at top level; this check is done.
process.exit(0);
