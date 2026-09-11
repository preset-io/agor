// Each package owns its aliases and host-env isolation setup. Fail before
// running tests with Vitest defaults when invoked from the repo root.
throw new Error(
  [
    'Run Vitest from a workspace package so its aliases and host-env isolation apply:',
    '  pnpm --filter @agor/daemon exec vitest run <path relative to the package>',
    '  # or: cd apps/agor-daemon && pnpm vitest run <path>',
    '',
    'For every package: pnpm test',
  ].join('\n')
);
