import fs from 'node:fs/promises';
import path from 'node:path';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, Link, Params } from '@agor/core/types';
import type { Request, Response } from 'express';
import { isPathInsideRoot } from '../utils/branch-workspace-path.js';
import { getUploadDirectory } from '../utils/upload.js';

const INLINE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const INLINE_TEXT_MIME_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown']);

const MAX_INLINE_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_INLINE_TEXT_SIZE = 1024 * 1024;

export class LinkContentError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ResolvedLinkContentFile {
  path: string;
  size: number;
  mimeType: string;
  filename: string;
}

function normalizeMimeType(value?: string | null): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

function encodeContentDispositionValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function asciiContentDispositionFallback(value: string): string {
  const fallback = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/gu, '_')
    .replace(/[\r\n"\\]/g, '_')
    .trim();
  return fallback || 'download';
}

function safeContentFilename(link: Pick<Link, 'title' | 'file_path' | 'metadata'>): string {
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
  const utf8Name = filename.replace(/[\r\n"\\]/g, '_') || 'download';
  const fallback = asciiContentDispositionFallback(utf8Name);
  const encoded = encodeContentDispositionValue(utf8Name);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function chooseLinkContentDisposition(args: {
  requestedDisposition?: unknown;
  mimeType: string;
  size: number;
}): 'inline' | 'attachment' {
  const requested = args.requestedDisposition === 'inline' ? 'inline' : 'attachment';
  const mimeType = normalizeMimeType(args.mimeType);

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

  if (!isPathInsideRoot(uploadRootReal, fileReal, { allowRoot: true })) {
    throw new LinkContentError(403, 'File content not available');
  }

  const mimeType = normalizeMimeType(link.mime_type) || 'application/octet-stream';

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
    create(
      data: {
        strategy: 'jwt';
        accessToken: string;
      },
      params?: Params
    ): Promise<{ user?: unknown; authentication?: unknown }>;
  };
  const result = await authService
    .create({ strategy: 'jwt', accessToken: token }, { headers: req.headers } as Params)
    .catch(() => {
      throw new LinkContentError(401, 'Authentication required');
    });

  return {
    user: result.user,
    provider: 'rest',
    authentication: result.authentication,
    // Preserve trusted-header tenancy and other request-scoped auth inputs
    // that Feathers normally copies into params before service hooks run.
    headers: req.headers,
  } as AuthenticatedParams;
}

function httpStatusForError(error: unknown): number {
  if (error instanceof LinkContentError) return error.status;
  if (!error || typeof error !== 'object') return 500;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  for (const value of [candidate.code, candidate.status, candidate.statusCode]) {
    if (typeof value === 'number') return value;
  }
  return 500;
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
      const status = httpStatusForError(error);
      const message = error instanceof Error ? error.message : 'Failed to load file content';
      res.status(status).json({ error: status >= 500 ? 'Failed to load file content' : message });
    }
  });
}
