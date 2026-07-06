import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Link } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  chooseLinkContentDisposition,
  contentDispositionHeader,
  LinkContentError,
  resolveUploadedLinkContentFile,
} from './link-content';

async function withTempUploads<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-link-content-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function link(patch: Partial<Link>): Link {
  return {
    link_id: 'link-1' as Link['link_id'],
    branch_id: null,
    session_id: 'session-1' as Link['session_id'],
    kind: 'document',
    source: 'upload',
    file_path: null,
    target_key: 'file:test',
    is_pinned: false,
    title: null,
    mime_type: 'text/plain',
    metadata: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...patch,
  } as Link;
}

describe('link content route helpers', () => {
  it('resolves uploaded files only when the real path remains inside the upload root', async () => {
    await withTempUploads(async (root) => {
      const filePath = path.join(root, 'note.txt');
      await fs.writeFile(filePath, 'hello');

      const resolved = await resolveUploadedLinkContentFile(
        link({ file_path: filePath, title: 'note.txt', mime_type: 'text/plain' }),
        root
      );

      expect(resolved).toMatchObject({
        path: await fs.realpath(filePath),
        size: 5,
        mimeType: 'text/plain',
      });
    });
  });

  it('rejects traversal, out-of-root paths, and symlinks', async () => {
    await withTempUploads(async (root) => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-link-outside-'));
      try {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        await fs.writeFile(outsideFile, 'secret');

        await expect(
          resolveUploadedLinkContentFile(link({ file_path: outsideFile }), root)
        ).rejects.toMatchObject({ status: 403 });

        const symlinkPath = path.join(root, 'secret-link.txt');
        await fs.symlink(outsideFile, symlinkPath);
        await expect(
          resolveUploadedLinkContentFile(link({ file_path: symlinkPath }), root)
        ).rejects.toMatchObject({ status: 403 });
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it('allows inline only for safe preview MIME types within caps', () => {
    expect(
      chooseLinkContentDisposition({
        requestedDisposition: 'inline',
        mimeType: 'image/png',
        size: 10,
      })
    ).toBe('inline');
    expect(
      chooseLinkContentDisposition({
        requestedDisposition: 'inline',
        mimeType: 'text/markdown',
        size: 10,
      })
    ).toBe('inline');
    expect(
      chooseLinkContentDisposition({
        requestedDisposition: 'attachment',
        mimeType: 'application/pdf',
        size: 10,
      })
    ).toBe('attachment');
    expect(() =>
      chooseLinkContentDisposition({
        requestedDisposition: 'inline',
        mimeType: 'application/pdf',
        size: 10,
      })
    ).toThrow(LinkContentError);
  });

  it('emits attachment-safe content disposition filenames', () => {
    expect(contentDispositionHeader('attachment', 'report "q1".pdf')).toContain(
      'attachment; filename="report _q1_.pdf"'
    );
  });
});
