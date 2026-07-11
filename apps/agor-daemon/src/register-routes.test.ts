import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Application } from '@agor/core/feathers';
import type { Link, SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  persistUploadLinksOrCleanup,
  resolveTrustedPromptUploadLinkIds,
  sanitizePromptTaskMetadata,
} from './register-routes';

describe('upload persistence cleanup', () => {
  it('deletes every newly written file when atomic link persistence fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-upload-cleanup-'));
    const paths = [path.join(root, 'a.txt'), path.join(root, 'b.txt')];
    await Promise.all(paths.map((file) => fs.writeFile(file, 'uploaded')));
    const failure = new Error('database unavailable');

    await expect(
      persistUploadLinksOrCleanup({
        uploadLinks: [{ session_id: 'session-1' as SessionID, source: 'upload' }],
        uploadedFiles: paths.map((file) => ({ path: file })),
        create: vi.fn(async () => {
          throw failure;
        }),
      })
    ).rejects.toBe(failure);

    await expect(Promise.all(paths.map((file) => fs.stat(file)))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('prompt route metadata hardening', () => {
  it('strips caller-supplied upload link ids from task metadata', () => {
    expect(
      sanitizePromptTaskMetadata({
        source: 'agor',
        upload_link_ids: ['spoofed-link' as never],
        widget_id: 'widget-1',
      })
    ).toEqual({
      source: 'agor',
      widget_id: 'widget-1',
    });
  });
});

describe('prompt upload attribution', () => {
  const uploadLink = {
    link_id: 'link-1',
    source: 'upload',
    session_id: 'session-1',
    branch_id: null,
    source_message_id: null,
    created_by: 'user-1',
  } as Link;

  it('trusts only an unattached upload owned by the prompting user and session', async () => {
    const get = vi.fn(async () => uploadLink);
    const app = { service: () => ({ get }) } as unknown as Application;

    await expect(
      resolveTrustedPromptUploadLinkIds(app, 'session-1' as SessionID, ['link-1'], {
        user: { user_id: 'user-1' },
      } as never)
    ).resolves.toEqual(['link-1']);
  });

  it('rejects an upload owned by a different user', async () => {
    const app = {
      service: () => ({ get: vi.fn(async () => ({ ...uploadLink, created_by: 'user-2' })) }),
    } as unknown as Application;

    await expect(
      resolveTrustedPromptUploadLinkIds(app, 'session-1' as SessionID, ['link-1'], {
        user: { user_id: 'user-1' },
      } as never)
    ).rejects.toThrow('Upload link does not belong to this prompt');
  });
});
