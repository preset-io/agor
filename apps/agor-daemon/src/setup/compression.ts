import compression from 'compression';
import type { Request, Response } from 'express';

/**
 * Dynamic response compression policy.
 *
 * Static UI assets are served before this middleware, using express-static-gzip
 * so pre-compressed files can be returned directly. Keep this middleware focused
 * on normal REST/JSON responses and avoid byte-for-byte relay or streaming
 * paths where compression can add buffering or alter upstream semantics.
 */
export function shouldCompressResponse(req: Request, res: Response): boolean {
  const requestPath = req.path || req.url || '';

  // `/proxies` is a pass-through byte relay for artifact HTTP proxying. Some
  // upstreams may stream responses (including SSE-like APIs), and the proxy
  // intentionally strips upstream content-encoding before relaying bytes. Do not
  // wrap that response in dynamic compression; let callers/upstreams control
  // streaming cadence and avoid extra buffering in this layer.
  if (requestPath === '/proxies' || requestPath.startsWith('/proxies/')) {
    return false;
  }

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
