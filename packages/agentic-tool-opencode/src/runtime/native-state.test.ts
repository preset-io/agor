import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertOpenCodeCheckpointRuntime,
  prepareOpenCodeScratch,
  pruneOpenCodeAttempts,
  publishOpenCodeCheckpoint,
  resolveOpenCodeNativeStateLayout,
  resolveOpenCodeScratchRoot,
  restoreOpenCodeAcceptedState,
} from './native-state.js';

const TASK_A = '01a08d5f-7773-77fa-a7dc-2575cfe6727e';
const TASK_B = '01a08d5f-7773-77fa-a7dc-2575cfe6727f';
const SESSION = '01a08d5f-775f-73f6-86a1-624b43050180';
const NAMESPACE = 'e'.repeat(64);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-native-state-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function layoutFor(taskId: string) {
  return resolveOpenCodeNativeStateLayout({
    namespaceKey: NAMESPACE,
    agorSessionId: SESSION,
    taskId,
    homeDir: join(root, 'home'),
    scratchRoot: join(root, 'scratch'),
  });
}

async function writeSqliteDatabase(path: string, rows: string[]): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO session (id) VALUES (?)');
    for (const row of rows) insert.run(row);
  } finally {
    db.close();
  }
}

async function readSessionIds(path: string): Promise<string[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('SELECT id FROM session ORDER BY id').all() as Array<{ id: string }>).map(
      (row) => row.id
    );
  } finally {
    db.close();
  }
}

describe('OpenCode hosted native state', () => {
  it('keeps every live root on scratch and only attempts under the home', () => {
    expect(() => layoutFor(TASK_A.toUpperCase())).toThrow(/canonical lowercase/);
    const layout = layoutFor(TASK_A);
    for (const path of [layout.liveDbPath, ...Object.values(layout.xdg)]) {
      expect(path.startsWith(join(root, 'scratch', TASK_A))).toBe(true);
    }
    expect(layout.attemptsDir).toBe(
      join(
        root,
        'home',
        '.local',
        'share',
        'agor',
        'opencode',
        NAMESPACE,
        'sessions',
        SESSION,
        'attempts'
      )
    );
  });

  it('publishes a checkpointed, integrity-verified copy and resumes from it in a fresh scratch', async () => {
    const first = layoutFor(TASK_A);
    await prepareOpenCodeScratch(first);
    await writeSqliteDatabase(first.liveDbPath, ['ses_1']);

    const attempt = await publishOpenCodeCheckpoint(first, {
      taskId: TASK_A,
      openCodeSessionId: 'ses_1',
    });

    expect(attempt).toMatchObject({
      version: 2,
      attemptTaskId: TASK_A,
      openCodeSessionId: 'ses_1',
    });
    expect(attempt.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const published = join(first.attemptsDir, TASK_A);
    expect(JSON.parse(await readFile(join(published, 'manifest.json'), 'utf8'))).toEqual(attempt);
    expect((await stat(join(published, 'opencode.db'))).size).toBe(attempt.bytes);
    // The WAL was truncated by the barrier, so the single file is complete.
    expect(await readSessionIds(join(published, 'opencode.db'))).toEqual(['ses_1']);

    const second = layoutFor(TASK_B);
    await prepareOpenCodeScratch(second);
    await restoreOpenCodeAcceptedState(second, attempt);
    expect(await readSessionIds(second.liveDbPath)).toEqual(['ses_1']);
  });

  it('fails closed when the accepted checkpoint is missing or does not match the pointer', async () => {
    const first = layoutFor(TASK_A);
    await prepareOpenCodeScratch(first);
    await writeSqliteDatabase(first.liveDbPath, ['ses_1']);
    const attempt = await publishOpenCodeCheckpoint(first, {
      taskId: TASK_A,
      openCodeSessionId: 'ses_1',
    });
    const second = layoutFor(TASK_B);
    await prepareOpenCodeScratch(second);

    await expect(
      restoreOpenCodeAcceptedState(second, { ...attempt, digest: `sha256:${'0'.repeat(64)}` })
    ).rejects.toThrow(/native state unavailable/);
    await writeFile(join(first.attemptsDir, TASK_A, 'opencode.db'), 'tampered');
    await expect(restoreOpenCodeAcceptedState(second, attempt)).rejects.toThrow(
      /does not match its digest/
    );
    await rm(join(first.attemptsDir, TASK_A), { recursive: true });
    await expect(restoreOpenCodeAcceptedState(second, attempt)).rejects.toThrow(
      /manifest is missing/
    );
    await expect(stat(second.liveDbPath)).rejects.toThrow();
  });

  it('refuses legacy or different-runtime checkpoints before restoring bytes', async () => {
    const first = layoutFor(TASK_A);
    await prepareOpenCodeScratch(first);
    await writeSqliteDatabase(first.liveDbPath, ['ses_1']);
    const attempt = await publishOpenCodeCheckpoint(first, {
      taskId: TASK_A,
      openCodeSessionId: 'ses_1',
    });
    const second = layoutFor(TASK_B);
    await prepareOpenCodeScratch(second);
    await expect(
      restoreOpenCodeAcceptedState(second, { ...attempt, version: 2, openCodeVersion: '0.0.1' })
    ).rejects.toThrow(/runtime version/);
    const { openCodeVersion: _version, ...legacy } = attempt as typeof attempt & {
      openCodeVersion: string;
    };
    await expect(restoreOpenCodeAcceptedState(second, { ...legacy, version: 1 })).rejects.toThrow(
      /runtime version/
    );
    await expect(stat(second.liveDbPath)).rejects.toThrow();
  });

  it('does not publish missing, empty, unrelated or wrong-session SQLite state', async () => {
    const layout = layoutFor(TASK_A);
    await prepareOpenCodeScratch(layout);
    const publish = () =>
      publishOpenCodeCheckpoint(layout, { taskId: TASK_A, openCodeSessionId: 'ses_1' });
    await expect(publish()).rejects.toThrow();
    await expect(stat(layout.liveDbPath)).rejects.toThrow();
    await writeFile(layout.liveDbPath, '');
    await expect(publish()).rejects.toThrow(/empty/);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(layout.liveDbPath);
    db.exec('CREATE TABLE unrelated (id TEXT)');
    db.close();
    await expect(publish()).rejects.toThrow(/no such table/);
    await writeSqliteDatabase(layout.liveDbPath, ['another_session']);
    await expect(publish()).rejects.toThrow(/does not contain the completed session/);
    await expect(stat(join(layout.attemptsDir, TASK_A, 'manifest.json'))).rejects.toThrow();
  });

  it('reports a non-durable checkpoint instead of publishing a partial artifact', async () => {
    const layout = layoutFor(TASK_A);
    await prepareOpenCodeScratch(layout);
    await writeSqliteDatabase(layout.liveDbPath, ['ses_1']);

    await expect(
      publishOpenCodeCheckpoint(
        layout,
        { taskId: TASK_A, openCodeSessionId: 'ses_1' },
        {
          checkpoint: async () => {
            throw new Error('ENOSPC: no space left on device');
          },
        }
      )
    ).rejects.toThrow(/checkpoint not durable: ENOSPC/);
    await expect(stat(join(layout.attemptsDir, TASK_A, 'manifest.json'))).rejects.toThrow();
  });

  it('prunes only attempts provably older than the launch pointer', async () => {
    // P0 < B < C in UUIDv7 order. A stale Job for C launched with pointer P0
    // must never delete B, which a later Job may have published and the daemon
    // accepted while C was still starting.
    const P0 = '01a08d5f-7773-77fa-a7dc-2575cfe67270';
    const OLD = '01a08d5f-7773-77fa-a7dc-2575cfe67260';
    const B = '01a08d5f-7773-77fa-a7dc-2575cfe67280';
    const C = '01a08d5f-7773-77fa-a7dc-2575cfe67290';
    const publish = async (taskId: string, rows: string[]) => {
      const layout = layoutFor(taskId);
      await prepareOpenCodeScratch(layout);
      await writeSqliteDatabase(layout.liveDbPath, rows);
      return publishOpenCodeCheckpoint(layout, { taskId, openCodeSessionId: 'ses_1' });
    };
    await publish(OLD, ['ses_1']);
    const accepted = await publish(P0, ['ses_1']);
    await publish(B, ['ses_1', 'newer']);
    await writeFile(join(layoutFor(C).attemptsDir, 'not-an-attempt'), 'keep');

    expect(await pruneOpenCodeAttempts(layoutFor(C), accepted)).toEqual([OLD]);
    expect((await readdir(layoutFor(C).attemptsDir)).sort()).toEqual([P0, B, 'not-an-attempt']);

    // Without an accepted pointer only entries older than this Job are removed.
    expect(await pruneOpenCodeAttempts(layoutFor(B), null)).toEqual([P0]);
    expect((await readdir(layoutFor(C).attemptsDir)).sort()).toEqual([B, 'not-an-attempt']);
    expect(await pruneOpenCodeAttempts(layoutFor(P0), null)).toEqual([]);
    expect(
      await pruneOpenCodeAttempts(layoutFor('01a08d5f-7773-77fa-a7dc-2575cfe672a0'), null)
    ).toEqual([B]);
  });

  it('refuses to run the durability barrier on a runtime without node:sqlite', async () => {
    await expect(
      assertOpenCodeCheckpointRuntime(async () => {
        throw new Error('No such built-in module: node:sqlite');
      })
    ).rejects.toThrow(/lacks node:sqlite/);
    await expect(assertOpenCodeCheckpointRuntime()).resolves.toBeUndefined();
  });
});

describe('OpenCode scratch root selection', () => {
  it('honors only an absolute launcher-provided scratch root and never TMPDIR', () => {
    expect(resolveOpenCodeScratchRoot({ AGOR_OPENCODE_SCRATCH_ROOT: '/tmp/agor-opencode' })).toBe(
      '/tmp/agor-opencode'
    );
    expect(() =>
      resolveOpenCodeScratchRoot({ AGOR_OPENCODE_SCRATCH_ROOT: 'relative/path', TMPDIR: '/x' })
    ).toThrow(/not pinned/);
    expect(() => resolveOpenCodeScratchRoot({ TMPDIR: '/persistent/home/tmp' })).toThrow(
      /not pinned/
    );
    expect(() =>
      resolveOpenCodeNativeStateLayout({
        namespaceKey: NAMESPACE,
        agorSessionId: SESSION,
        taskId: TASK_A,
        homeDir: join(root, 'home'),
      })
    ).toThrow(/AGOR_OPENCODE_SCRATCH_ROOT/);
  });
});
