import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('browser upload route boundary ordering', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it('authenticates and authorizes before the multipart parser can accept bytes', () => {
    const route = source.slice(source.indexOf("'/sessions/:sessionId/upload'"));
    expect(route.indexOf('uploadAuthMiddleware')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
    expect(route.indexOf('authorizeUpload')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
  });

  it('does not expose Multer buffers or physical file paths in the response contract', () => {
    const handler = source.slice(
      source.indexOf('const uploadHandler'),
      source.indexOf('const uploadLogger')
    );
    expect(handler).not.toContain('f.buffer');
    expect(handler).not.toContain('f.path');
    expect(handler).toContain('ref: staged.ref');
  });

  it('carries authentication params so the JWT user lookup receives tenant scope', () => {
    const start = source.indexOf('const uploadAuthMiddleware');
    const middleware = source.slice(
      start,
      source.indexOf("(app as any).post(\n    '/sessions/:sessionId/upload'", start)
    );

    expect(start).toBeGreaterThan(0);
    expect(middleware).toContain(
      'const authParams: AuthenticatedParams = { headers: req.headers }'
    );
    expect(middleware).toMatch(/authService\.create\([\s\S]*authParams\s*\)/);
    expect(middleware).toContain('authParams.tenant ??');
  });
});
