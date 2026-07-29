import compression from 'compression';
import type { Request, Response } from 'express';

/**
 * Dynamic response compression policy.
 *
 * Static UI assets are served before this middleware, using express-static-gzip
 * so pre-compressed files can be returned directly. Keep this middleware focused
 * on normal REST/JSON responses and avoid streaming paths where compression can
 * add buffering.
 */
export function shouldCompressResponse(req: Request, res: Response): boolean {
  // Defense-in-depth for any future Express-mounted SSE route. The app's
  // current real-time path is Socket.IO, but this keeps compression from
  // buffering event streams if a route later sets this content type.
  const contentType = String(res.getHeader('Content-Type') ?? '').toLowerCase();
  if (contentType.startsWith('text/event-stream')) {
    return false;
  }

  return compression.filter(req, res);
}

export function createDynamicCompressionMiddleware(): ReturnType<typeof compression> {
  return compression({ filter: shouldCompressResponse });
}
