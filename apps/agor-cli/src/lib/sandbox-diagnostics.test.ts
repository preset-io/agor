import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnoseSandbox, hasBinaryOnPath } from './sandbox-diagnostics';

describe('hasBinaryOnPath', () => {
  it('returns false when PATH is empty', () => {
    expect(hasBinaryOnPath('bwrap', '')).toBe(false);
  });
  it('returns false for a binary that does not exist on the given PATH', () => {
    expect(hasBinaryOnPath('definitely-not-a-real-binary-xyz', '/nonexistent')).toBe(false);
  });
});

describe('diagnoseSandbox', () => {
  // A temp dir holding a fake executable `bwrap` so PATH resolution is
  // deterministic regardless of the host, while the userns probe is injected.
  let fakeBin: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'agor-sbx-'));
    writeFileSync(join(fakeBin, 'bwrap'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeBin, 'bwrap'), 0o755);
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(fakeBin, { recursive: true, force: true });
  });

  it('reports disabled when the flag is off', () => {
    const d = diagnoseSandbox(
      { execution: { sandbox: { enabled: false } } },
      'linux',
      () => true,
      () => true,
      () => true,
      () => true
    );
    expect(d.enabled).toBe(false);
    expect(d.ok).toBe(false);
  });

  it('marks non-linux platforms unsupported (bubblewrap is Linux-only)', () => {
    for (const p of ['darwin', 'win32'] as const) {
      const d = diagnoseSandbox({ execution: { sandbox: { enabled: true } } }, p, () => true);
      expect(d.supported).toBe(false);
      expect(d.ok).toBe(false);
    }
  });

  it('is not ok when bwrap is missing from PATH', () => {
    process.env.PATH = '';
    const d = diagnoseSandbox({ execution: { sandbox: { enabled: true } } }, 'linux', () => true);
    expect(d.ok).toBe(false);
    expect(d.deps.map((x) => x.name)).toEqual(['bwrap']); // userns dep not added when bwrap absent
    expect(d.deps.every((x) => !x.present)).toBe(true);
  });

  it('when bwrap present, adds required userns + optional PID-ns deps', () => {
    process.env.PATH = fakeBin;
    const pass = diagnoseSandbox(
      { execution: { sandbox: { enabled: true } } },
      'linux',
      () => true,
      () => true,
      () => true,
      () => true
    );
    expect(pass.deps.map((x) => x.name)).toEqual([
      'bwrap',
      'safe setup paths',
      'unprivileged userns',
      'descriptor binds',
      'PID namespace',
    ]);
    expect(pass.ok).toBe(true);

    // bwrap installed but userns blocked (hardened kernel) → NOT ok.
    process.env.PATH = fakeBin;
    const blocked = diagnoseSandbox(
      { execution: { sandbox: { enabled: true } } },
      'linux',
      () => false,
      () => false,
      () => true,
      () => true
    );
    expect(blocked.deps.find((x) => x.name === 'unprivileged userns')?.present).toBe(false);
    expect(blocked.ok).toBe(false);
  });

  it('stays ok when PID namespace is unavailable (best-effort, not required)', () => {
    process.env.PATH = fakeBin;
    const d = diagnoseSandbox(
      { execution: { sandbox: { enabled: true } } },
      'linux',
      () => true, // userns ok
      () => false, // PID ns blocked (container)
      () => true, // 0.12+ setup path resolution
      () => true // fd binds
    );
    const pidDep = d.deps.find((x) => x.name === 'PID namespace');
    expect(pidDep).toMatchObject({ required: false, present: false });
    expect(d.ok).toBe(true); // still usable — userns is the required baseline
  });

  it('fails closed when setup paths or descriptor binds are unsafe', () => {
    process.env.PATH = fakeBin;
    const oldVersion = diagnoseSandbox(
      { execution: { sandbox: { enabled: true } } },
      'linux',
      () => true,
      () => true,
      () => false,
      () => true
    );
    expect(oldVersion.deps.find((x) => x.name === 'safe setup paths')?.present).toBe(false);
    expect(oldVersion.ok).toBe(false);

    const noBindFd = diagnoseSandbox(
      { execution: { sandbox: { enabled: true } } },
      'linux',
      () => true,
      () => true,
      () => true,
      () => false
    );
    expect(noBindFd.deps.find((x) => x.name === 'descriptor binds')?.present).toBe(false);
    expect(noBindFd.ok).toBe(false);
  });
});
