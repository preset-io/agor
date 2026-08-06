import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('prompt and widget transaction scopes', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it('uses the long-route identity scope and short Task repository units for prompt admission', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const promptEnd = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart - 100, promptEnd);

    expect(promptStart).toBeGreaterThan(0);
    expect(prompt).toContain('registerLongAuthenticatedRoute(');
    expect(prompt).toContain('bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db))');
    expect(prompt).not.toContain(
      "registerAuthenticatedRoute(\n    app,\n    '/sessions/:id/prompt'"
    );
  });

  it('does not keep a route-wide tenant transaction over widget external work', () => {
    for (const path of ["'/widgets/:id/submit'", "'/widgets/:id/dismiss'"]) {
      const start = source.indexOf(path);
      const route = source.slice(start - 100, start + 900);
      expect(start).toBeGreaterThan(0);
      expect(route).toContain('registerLongAuthenticatedRoute(');
    }
  });
});
