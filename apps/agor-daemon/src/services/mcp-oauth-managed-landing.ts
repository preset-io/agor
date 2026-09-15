import { UI_MOUNT_PATH } from '@agor/core/utils/url';
import type { NextFunction, Request, Response } from 'express';
/** No fragment reaches the server. Relative Location preserves it in the same browser tab. */
export function managedOAuthLanding(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' || (req.path !== '/' && req.path !== '')) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Tickets are fragment-only; reject query transport without echoing it.
  if (req.originalUrl.includes('?')) {
    res.status(400).end();
    return;
  }
  res.redirect(303, `${UI_MOUNT_PATH}/mcp-oauth/complete`);
}
