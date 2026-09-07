import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type MCPOAuthCallbackHandler = (req: Request, res: Response) => void | Promise<void>;

/**
 * Mount this before Feathers REST, then install the real handler after service
 * registration. The closure avoids an untyped property on the Feathers app and
 * returns an explicit temporary failure instead of falling through to a 404.
 */
export function createMCPOAuthCallbackRoute(): {
  middleware: RequestHandler;
  setHandler: (handler: MCPOAuthCallbackHandler) => void;
} {
  let callbackHandler: MCPOAuthCallbackHandler | null = null;

  return {
    middleware: (req: Request, res: Response, next: NextFunction): void => {
      if (req.method !== 'GET' || req.path !== '/') {
        next();
        return;
      }

      if (!callbackHandler) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.status(503).send('OAuth callback is not ready. Please retry.');
        return;
      }

      Promise.resolve(callbackHandler(req, res)).catch(next);
    },
    setHandler: (handler: MCPOAuthCallbackHandler): void => {
      callbackHandler = handler;
    },
  };
}
