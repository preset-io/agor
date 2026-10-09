import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GlobOptions } from 'glob';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ cwd: '' }));

// Exercise the real build config and glob matching against an isolated source
// tree, including test helpers that may not exist on this branch yet.
vi.mock('glob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('glob')>();
  return {
    ...actual,
    glob: {
      ...actual.glob,
      sync: (pattern: string, options: GlobOptions) =>
        actual.glob.sync(pattern, { ...options, cwd: fixture.cwd }),
    },
  };
});

it('keeps test suites and shared test fixtures out of daemon build entries', async () => {
  fixture.cwd = await mkdtemp(join(tmpdir(), 'agor-daemon-build-entries-'));
  try {
    for (const relative of [
      'src/main.ts',
      'src/services/user-avatar-sync.ts',
      'src/services/user-avatar-sync.test-fixtures.ts',
      'src/services/user-avatar-sync.test.ts',
      'src/services/user-avatar-sync.postgres.test.ts',
      'src/services/example.spec.ts',
    ]) {
      const path = join(fixture.cwd, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'export {};\n');
    }

    const { default: config } = await import('../tsup.config');
    expect(config).toHaveProperty('entry', {
      main: 'src/main.ts',
      'services/user-avatar-sync': 'src/services/user-avatar-sync.ts',
    });
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});
