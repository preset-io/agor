import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPENCODE_VERSION } from '../shared/known-models.js';
import {
  type OpenCodeNativeStateLayout,
  prepareOpenCodeScratch,
  removeOpenCodeCheckpoints,
  resolveOpenCodeNativeStateLayout,
  restoreOpenCodeCheckpoint,
  sealOpenCodeCheckpoint,
} from './native-state.js';

const SESSION = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50';
const TASK_1 = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51';
const TASK_2 = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-state-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function layoutFor(taskId: string): OpenCodeNativeStateLayout {
  return resolveOpenCodeNativeStateLayout({
    sessionId: SESSION,
    taskId,
    sdkHomeScope: 'execution_home',
    env: { AGOR_OPENCODE_SCRATCH_ROOT: join(root, 'scratch') },
    homeDir: join(root, 'home'),
  });
}

/** Simulate what a live OpenCode server leaves behind: a WAL database with one session row. */
async function writeLiveDatabase(layout: OpenCodeNativeStateLayout, sessionId: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(layout.liveDbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO session (id) VALUES (?)').run(sessionId);
  db.close();
}

describe('OpenCode native state', () => {
  it('requires a pinned absolute scratch root and canonical ids', () => {
    expect(() =>
      resolveOpenCodeNativeStateLayout({
        sessionId: SESSION,
        taskId: TASK_1,
        sdkHomeScope: 'execution_home',
        env: {},
      })
    ).toThrow(/AGOR_OPENCODE_SCRATCH_ROOT/);
    expect(() =>
      resolveOpenCodeNativeStateLayout({
        sessionId: '../escape',
        taskId: TASK_1,
        sdkHomeScope: 'execution_home',
        env: { AGOR_OPENCODE_SCRATCH_ROOT: '/scratch' },
      })
    ).toThrow(/canonical/);
  });

  it('keeps branch-home checkpoints in the pinned branch root, never the caller home', () => {
    const branch = {
      sessionId: SESSION,
      taskId: TASK_1,
      sdkHomeScope: 'branch' as const,
      homeDir: '/home/caller',
    };
    expect(
      resolveOpenCodeNativeStateLayout({
        ...branch,
        env: {
          AGOR_OPENCODE_SCRATCH_ROOT: '/scratch',
          AGOR_OPENCODE_CHECKPOINT_ROOT: '/branch-homes/b1/opencode',
        },
      }).sessionsDir
    ).toBe('/branch-homes/b1/opencode/sessions');
    expect(() =>
      resolveOpenCodeNativeStateLayout({
        ...branch,
        env: { AGOR_OPENCODE_SCRATCH_ROOT: '/scratch' },
      })
    ).toThrow(/AGOR_OPENCODE_CHECKPOINT_ROOT/);
    expect(() =>
      resolveOpenCodeNativeStateLayout({
        ...branch,
        env: { AGOR_OPENCODE_SCRATCH_ROOT: '/scratch', AGOR_OPENCODE_CHECKPOINT_ROOT: 'relative' },
      })
    ).toThrow(/AGOR_OPENCODE_CHECKPOINT_ROOT/);
    expect(() =>
      resolveOpenCodeNativeStateLayout({
        ...branch,
        sdkHomeScope: undefined as never,
        env: { AGOR_OPENCODE_SCRATCH_ROOT: '/scratch' },
      })
    ).toThrow(/known SDK-home scope/);
  });

  it('restores a checkpoint saved by an older OpenCode version', async () => {
    const first = layoutFor(TASK_1);
    await prepareOpenCodeScratch(first);
    await writeLiveDatabase(first, 'ses_1');
    const manifest = await sealOpenCodeCheckpoint(first, 'ses_1');
    const second = layoutFor(TASK_2);
    await prepareOpenCodeScratch(second);
    await expect(
      restoreOpenCodeCheckpoint(second, { ...manifest, openCodeVersion: '0.0.1' })
    ).resolves.toBeUndefined();
  });

  it('seals a verified checkpoint in the home and restores it for the next turn', async () => {
    const first = layoutFor(TASK_1);
    await prepareOpenCodeScratch(first);
    await writeLiveDatabase(first, 'ses_1');
    const manifest = await sealOpenCodeCheckpoint(first, 'ses_1');
    expect(manifest).toMatchObject({
      version: 1,
      taskId: TASK_1,
      openCodeSessionId: 'ses_1',
      openCodeVersion: OPENCODE_VERSION,
    });

    const second = layoutFor(TASK_2);
    await prepareOpenCodeScratch(second);
    await restoreOpenCodeCheckpoint(second, manifest);
    const { DatabaseSync } = await import('node:sqlite');
    const restored = new DatabaseSync(second.liveDbPath);
    expect(restored.prepare('SELECT id FROM session').all()).toEqual([{ id: 'ses_1' }]);
    restored.close();
  });

  it('refuses to seal a database without the completed session or twice for one Task', async () => {
    const layout = layoutFor(TASK_1);
    await prepareOpenCodeScratch(layout);
    await writeLiveDatabase(layout, 'ses_1');
    await expect(sealOpenCodeCheckpoint(layout, 'ses_other')).rejects.toThrow(
      /does not contain the completed session/
    );
    await sealOpenCodeCheckpoint(layout, 'ses_1');
    await expect(sealOpenCodeCheckpoint(layout, 'ses_1')).rejects.toThrow(/not durable/);
  });

  it('refuses to seal a checkpoint that holds OpenCode-stored credentials', async () => {
    const layout = layoutFor(TASK_1);
    await prepareOpenCodeScratch(layout);
    await writeLiveDatabase(layout, 'ses_1');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(layout.liveDbPath);
    db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT)');
    db.exec("INSERT INTO credential VALUES ('c1', 'sk-secret')");
    db.close();
    await expect(sealOpenCodeCheckpoint(layout, 'ses_1')).rejects.toThrow(/stored credentials/);
  });

  it('refuses to seal a checkpoint that holds an OpenCode share secret', async () => {
    const layout = layoutFor(TASK_1);
    await prepareOpenCodeScratch(layout);
    await writeLiveDatabase(layout, 'ses_1');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(layout.liveDbPath);
    db.exec('CREATE TABLE session_share (session_id TEXT PRIMARY KEY, secret TEXT, url TEXT)');
    db.exec("INSERT INTO session_share VALUES ('ses_1', 'share-secret', 'https://x')");
    db.close();
    await expect(sealOpenCodeCheckpoint(layout, 'ses_1')).rejects.toThrow(/stored credentials/);
  });

  it('fails closed when the saved conversation is missing, altered, or from another version', async () => {
    const first = layoutFor(TASK_1);
    await prepareOpenCodeScratch(first);
    await writeLiveDatabase(first, 'ses_1');
    const manifest = await sealOpenCodeCheckpoint(first, 'ses_1');
    const second = layoutFor(TASK_2);
    await prepareOpenCodeScratch(second);

    await expect(
      restoreOpenCodeCheckpoint(second, { ...manifest, openCodeVersion: '999.0.0' })
    ).rejects.toThrow(/saved by newer OpenCode 999.0.0/);
    await expect(
      restoreOpenCodeCheckpoint(second, { ...manifest, taskId: TASK_2 })
    ).rejects.toThrow(/missing from its checkpoint store/);
    await writeFile(
      join(first.sessionsDir, SESSION, 'attempts', TASK_1, 'opencode.db'),
      'tampered'
    );
    await expect(restoreOpenCodeCheckpoint(second, manifest)).rejects.toThrow(
      /failed verification/
    );
    await expect(stat(second.liveDbPath)).rejects.toThrow();
  });

  it('removes exactly the listed attempts', async () => {
    for (const taskId of [TASK_1, TASK_2]) {
      const layout = layoutFor(taskId);
      await prepareOpenCodeScratch(layout);
      await writeLiveDatabase(layout, 'ses_1');
      await sealOpenCodeCheckpoint(layout, 'ses_1');
    }
    const layout = layoutFor(TASK_2);
    const attempts = join(layout.sessionsDir, SESSION, 'attempts');

    await expect(
      removeOpenCodeCheckpoints(layout, [{ sessionId: SESSION, taskId: TASK_1 }])
    ).resolves.toEqual([{ sessionId: SESSION, taskId: TASK_1 }]);
    expect(await readdir(attempts)).toEqual([TASK_2]);
  });
});
