import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Unpatched Node.js Brotli decoders can be exploited by a malformed body (CVE-2026-111497).
export function hasBrotliContentEncoding(header: string | undefined): boolean {
  return (header ?? '').split(',').some((coding) => coding.trim().toLowerCase() === 'br');
}

/** Rejects `Content-Encoding: br` request bodies before any body parser decompresses them. */
export function rejectBrotliRequestBodies(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hasBrotliContentEncoding(req.headers['content-encoding'])) {
      next();
      return;
    }
    // Answer directly: the Feathers error handler would turn a thrown 415 into a logged 500.
    res.status(415).set('Accept-Encoding', 'gzip, deflate').json({
      name: 'UnsupportedMediaType',
      message: 'Unsupported Content-Encoding "br"',
      code: 415,
    });
  };
}
