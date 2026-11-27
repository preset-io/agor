import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexThreadRetirementPayloadSchema } from '../payload-types.js';
import { handleCodexThreadRetirement } from './codex-thread-retirement.js';

const { retireThread, close } = vi.hoisted(() => ({ retireThread: vi.fn(), close: vi.fn() }));
vi.mock('../sdk-handlers/codex/app-server-client.js', () => ({
  CodexAppServerClient: class {
    retireThread = retireThread;
    close = close;
  },
}));

const sqlite = await import('node:sqlite').catch(() => undefined);

it.skipIf(!sqlite)(
  'probes the second index before attempting deletion when the state index contains the thread',
  async () => {
    if (!sqlite) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agor-codex-retirement-test-')));
    try {
      const branchId = '00000000-0000-4000-8000-000000000001';
      const threadId = '00000000-0000-4000-8000-000000000002';
      const home = join(root, 'branch-homes', branchId, 'codex');
      await mkdir(home, { recursive: true });
      const state = new sqlite.DatabaseSync(join(home, 'state_5.sqlite'));
      state.exec(
        'CREATE TABLE threads (id TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)'
      );
      state.prepare('INSERT INTO threads VALUES (?)').run(threadId);
      state.close();
      await writeFile(join(home, 'thread_history_1.sqlite'), 'invalid SQLite file');
      const payload = CodexThreadRetirementPayloadSchema.parse({
        command: 'codex.thread-retire',
        params: { branchId, threadId, codexHome: home, cwd: root, principalBranchAccess: 'read' },
      });
      await expect(handleCodexThreadRetirement(payload, {})).resolves.toMatchObject({
        success: false,
        error: { code: 'CODEX_RETIREMENT_UNCONFIRMED' },
      });
      expect(retireThread).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
