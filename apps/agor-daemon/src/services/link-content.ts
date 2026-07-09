import fs from 'node:fs/promises';
import path from 'node:path';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, Link, Params } from '@agor/core/types';
import type { Request, Response } from 'express';
import { ALLOWED_UPLOAD_MIME_TYPES, getUploadDirectory } from '../utils/upload.js';

export const INLINE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const INLINE_TEXT_MIME_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown']);

export const MAX_INLINE_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_INLINE_TEXT_SIZE = 1024 * 1024;

export class LinkContentError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ResolvedLinkContentFile {
  path: string;
  size: number;
  mimeType: string;
  filename: string;
}

function normalizeMimeType(value?: string | null): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function encodeContentDispositionValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

export function safeContentFilename(link: Pick<Link, 'title' | 'file_path' | 'metadata'>): string {
  const metadata = link.metadata && typeof link.metadata === 'object' ? link.metadata : {};
  const metadataName =
    typeof metadata.originalName === 'string'
      ? metadata.originalName
      : typeof metadata.filename === 'string'
        ? metadata.filename
        : null;
  const fallback =
    link.title || metadataName || (link.file_path ? path.basename(link.file_path) : 'download');
  const basename = path
    .basename(fallback)
    .replace(/[\r\n"\\]/g, '_')
    .trim();
  return basename || 'download';
}

export function contentDispositionHeader(
  disposition: 'inline' | 'attachment',
  filename: string
): string {
  const safeName = filename.replace(/[\r\n"\\]/g, '_') || 'download';
  const encoded = encodeContentDispositionValue(safeName);
  return `${disposition}; filename="${safeName}"; filename*=UTF-8''${encoded}`;
}

export function chooseLinkContentDisposition(args: {
  requestedDisposition?: unknown;
  mimeType: string;
  size: number;
}): 'inline' | 'attachment' {
  const requested = args.requestedDisposition === 'inline' ? 'inline' : 'attachment';
  const mimeType = normalizeMimeType(args.mimeType);

  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
    throw new LinkContentError(415, 'Unsupported file type');
  }

  if (requested !== 'inline') return 'attachment';

  if (INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    if (args.size > MAX_INLINE_IMAGE_SIZE) {
      throw new LinkContentError(413, 'File is too large to preview inline');
    }
    return 'inline';
  }

  if (INLINE_TEXT_MIME_TYPES.has(mimeType)) {
    if (args.size > MAX_INLINE_TEXT_SIZE) {
      throw new LinkContentError(413, 'File is too large to preview inline');
    }
    return 'inline';
  }

  throw new LinkContentError(415, 'File type is not previewable inline');
}

export async function resolveUploadedLinkContentFile(
  link: Pick<Link, 'source' | 'file_path' | 'mime_type' | 'title' | 'metadata'>,
  uploadRoot = getUploadDirectory()
): Promise<ResolvedLinkContentFile> {
  if (link.source !== 'upload' || !link.file_path) {
    throw new LinkContentError(404, 'File content not found');
  }

  const uploadRootReal = await fs.realpath(uploadRoot).catch(() => {
    throw new LinkContentError(404, 'File content not found');
  });

  const candidatePath = path.isAbsolute(link.file_path)
    ? path.resolve(link.file_path)
    : path.resolve(uploadRoot, link.file_path);

  const lstat = await fs.lstat(candidatePath).catch(() => {
    throw new LinkContentError(404, 'File content not found');
  });

  if (lstat.isSymbolicLink()) {
    throw new LinkContentError(403, 'File content not available');
  }
  if (!lstat.isFile()) {
    throw new LinkContentError(404, 'File content not found');
  }

  const fileReal = await fs.realpath(candidatePath).catch(() => {
    throw new LinkContentError(404, 'File content not found');
  });

  if (!isPathInside(uploadRootReal, fileReal)) {
    throw new LinkContentError(403, 'File content not available');
  }

  const mimeType = normalizeMimeType(link.mime_type);
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
    throw new LinkContentError(415, 'Unsupported file type');
  }

  return {
    path: fileReal,
    size: lstat.size,
    mimeType,
    filename: safeContentFilename(link),
  };
}

async function authenticateBearerRequest(
  app: Application,
  req: Request
): Promise<AuthenticatedParams> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (!token) throw new LinkContentError(401, 'Authentication required');

  const authService = app.service('authentication') as unknown as {
    create(data: {
      strategy: 'jwt';
      accessToken: string;
    }): Promise<{ user?: unknown; authentication?: unknown }>;
  };
  const result = await authService.create({ strategy: 'jwt', accessToken: token }).catch(() => {
    throw new LinkContentError(401, 'Authentication required');
  });

  return {
    user: result.user,
    provider: 'rest',
    authentication: result.authentication,
  } as AuthenticatedParams;
}

export function registerLinkContentRoute(app: Application): void {
  // biome-ignore lint/suspicious/noExplicitAny: Express route method is not represented on Feathers Application.
  (app as any).get('/link-content/:linkId', async (req: Request, res: Response) => {
    try {
      const params = await authenticateBearerRequest(app, req);
      const link = (await app.service('links').get(req.params.linkId, params as Params)) as Link;
      const file = await resolveUploadedLinkContentFile(link);
      const disposition = chooseLinkContentDisposition({
        requestedDisposition: req.query.disposition,
        mimeType: file.mimeType,
        size: file.size,
      });

      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Length', String(file.size));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', contentDispositionHeader(disposition, file.filename));
      res.sendFile(file.path);
    } catch (error) {
      const status =
        error instanceof LinkContentError
          ? error.status
          : typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code ?? 500)
            : typeof (error as { status?: unknown }).status === 'number'
              ? ((error as { status: number }).status ?? 500)
              : typeof (error as { statusCode?: unknown }).statusCode === 'number'
                ? ((error as { statusCode: number }).statusCode ?? 500)
                : 500;
      const message = error instanceof Error ? error.message : 'Failed to load file content';
      res.status(status).json({ error: status >= 500 ? 'Failed to load file content' : message });
    }
  });
}
