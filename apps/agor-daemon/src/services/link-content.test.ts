import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Forbidden } from '@agor/core/feathers';
import type { Link } from '@agor/core/types';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  chooseLinkContentDisposition,
  contentDispositionHeader,
  LinkContentError,
  registerLinkContentRoute,
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
        link({ file_path: 'note.txt', title: 'note.txt', mime_type: 'text/plain' }),
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
        mimeType: 'text/html',
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

  it('resolves arbitrary uploaded file types for attachment download', async () => {
    await withTempUploads(async (root) => {
      await fs.writeFile(path.join(root, 'payload.custom'), 'payload');

      await expect(
        resolveUploadedLinkContentFile(
          link({ file_path: 'payload.custom', mime_type: 'application/x-custom' }),
          root
        )
      ).resolves.toMatchObject({ mimeType: 'application/x-custom' });
    });
  });

  it('emits attachment-safe content disposition filenames', () => {
    expect(contentDispositionHeader('attachment', 'report "q1".pdf')).toContain(
      'attachment; filename="report _q1_.pdf"'
    );
  });

  it('requires bearer auth before resolving link content', async () => {
    let handler: (req: Request, res: Response) => Promise<void> = async () => {};
    const app = {
      get: vi.fn((_path: string, routeHandler: typeof handler) => {
        handler = routeHandler;
      }),
      service: vi.fn(),
    };
    registerLinkContentRoute(app as never);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await handler(
      { headers: {}, params: { linkId: 'link-1' }, query: {} } as unknown as Request,
      { status } as unknown as Response
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(app.service).not.toHaveBeenCalledWith('links');
  });

  it('propagates link visibility/RBAC denials from links.get', async () => {
    let handler: (req: Request, res: Response) => Promise<void> = async () => {};
    const linksGet = vi.fn(async () => {
      throw new Forbidden('Link not visible');
    });
    const authCreate = vi.fn(async () => ({
      user: { user_id: 'user-1' },
      authentication: { strategy: 'jwt' },
    }));
    const app = {
      get: vi.fn((_path: string, routeHandler: typeof handler) => {
        handler = routeHandler;
      }),
      service: vi.fn((pathName: string) => {
        if (pathName === 'authentication') {
          return { create: authCreate };
        }
        if (pathName === 'links') return { get: linksGet };
        throw new Error(`Unexpected service: ${pathName}`);
      }),
    };
    registerLinkContentRoute(app as never);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await handler(
      {
        headers: { authorization: 'Bearer token', 'x-agor-tenant-id': 'tenant-1' },
        params: { linkId: 'link-1' },
        query: {},
      } as unknown as Request,
      { status } as unknown as Response
    );

    expect(linksGet).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({
        provider: 'rest',
        user: { user_id: 'user-1' },
        headers: expect.objectContaining({ 'x-agor-tenant-id': 'tenant-1' }),
      })
    );
    expect(authCreate).toHaveBeenCalledWith(
      { strategy: 'jwt', accessToken: 'token' },
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-agor-tenant-id': 'tenant-1' }),
      })
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Link not visible' });
  });
});
