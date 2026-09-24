import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const handles = vi.hoisted(() => ({ active: false, sourceCloses: 0, targetCloses: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!handles.active) return handle;
      const path = String(args[0]);
      if (path.endsWith('/opencode.db')) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          handles.sourceCloses++;
          await close();
        });
      } else if (path.includes('/.opencode.db.tmp-')) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          handles.targetCloses++;
          await close();
        });
        vi.spyOn(handle, 'write').mockRejectedValueOnce(new Error('synthetic copy write failure'));
      }
      return handle;
    },
  };
});

import {
  prepareOpenCodeScratch,
  publishOpenCodeCheckpoint,
  resolveOpenCodeNativeStateLayout,
} from './native-state.js';

let root: string | undefined;
afterEach(async () => {
  handles.active = false;
  handles.sourceCloses = 0;
  handles.targetCloses = 0;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it('closes both FileHandle owners once and removes the partial copy after a write failure', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-copy-handles-')));
  const taskId = '01a08d5f-7773-77fa-a7dc-2575cfe6727e';
  const layout = resolveOpenCodeNativeStateLayout({
    namespaceKey: 'e'.repeat(64),
    agorSessionId: '01a08d5f-775f-73f6-86a1-624b43050180',
    taskId,
    storeId: '01a08d5f-7773-77fa-a7dc-2575cfe67260',
    homeDir: join(root, 'home'),
    scratchRoot: join(root, 'scratch'),
  });
  await prepareOpenCodeScratch(layout);
  await writeFile(layout.liveDbPath, 'synthetic private DB bytes');
  handles.active = true;
  await expect(
    publishOpenCodeCheckpoint(
      layout,
      { taskId, openCodeSessionId: 'ses_1' },
      { checkpoint: async () => {} }
    )
  ).rejects.toThrow(/synthetic copy write failure/);
  handles.active = false;
  expect(handles.sourceCloses).toBe(1);
  expect(handles.targetCloses).toBe(1);
  const entries = await readdir(join(layout.attemptsDir, taskId));
  expect(entries).toEqual([]);
  // A later, unrelated descriptor remains usable; no stream finalizer owns it.
  const unrelated = join(root, 'unrelated');
  await writeFile(unrelated, 'still openable');
  expect(await readFile(unrelated, 'utf8')).toBe('still openable');
});
