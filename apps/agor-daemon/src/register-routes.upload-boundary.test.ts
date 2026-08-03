import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('browser upload route boundary ordering', () => {
  it('authenticates and authorizes before the multipart parser can accept bytes', () => {
    const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    const route = source.slice(source.indexOf("'/sessions/:sessionId/upload'"));
    expect(route.indexOf('uploadAuthMiddleware')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
    expect(route.indexOf('authorizeUpload')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
  });

  it('does not expose Multer buffers or physical file paths in the response contract', () => {
    const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    const handler = source.slice(
      source.indexOf('const uploadHandler'),
      source.indexOf('const uploadLogger')
    );
    expect(handler).not.toContain('f.buffer');
    expect(handler).not.toContain('f.path');
    expect(handler).toContain('ref: staged.ref');
  });
});
