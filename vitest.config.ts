/**
 * There is no repo-root Vitest project — this file exists to say so loudly.
 *
 * Every suite lives in a workspace package, and each package's
 * `vitest.config.ts` supplies the module aliases and the `setupFiles` entry
 * that points HOME at an empty directory (`test/isolate-host-env.ts`).
 *
 * Run Vitest from the repo root and none of that applies: Vitest finds no
 * project config, falls back to its defaults, and the suite reads the
 * developer's real `~/.agor/config.yaml`. Because config validation rejects
 * unrecognized keys, the run then dies with `Config error: unrecognized keys:
 * ...` — an error about the developer's machine, from a runner problem. That
 * misreading has cost real debugging time.
 *
 * The setup file cannot catch this: if the project config never loaded, the
 * setup file never ran, so there is nothing to assert from. The root config is
 * the only place the mistake is still visible, which is why the guard lives
 * here rather than alongside the other isolation checks.
 */

throw new Error(
  [
    'Vitest was run from the repo root, where Agor has no project config.',
    '',
    'Nothing here supplies the module aliases or the host-env isolation in',
    'setupFiles, so the run would read your real ~/.agor/config.yaml and most',
    'likely fail with "Config error: unrecognized keys: ...". That error is',
    'about this invocation, not about your config.',
    '',
    'Run from the package that owns the test instead:',
    '  pnpm --filter @agor/daemon exec vitest run <path relative to the package>',
    '  # or: cd apps/agor-daemon && pnpm vitest run <path>',
    '',
    'Every package: pnpm test',
  ].join('\n')
);
