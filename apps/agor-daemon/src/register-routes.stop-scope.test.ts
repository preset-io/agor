import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Stop route transaction scope', () => {
  it('does not hold a tenant DB transaction while awaiting executor acknowledgement', () => {
    const source = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
    const stopSection = source.slice(
      source.indexOf('// Stop endpoint'),
      source.indexOf('// Queue listing', source.indexOf('// Stop endpoint'))
    );

    expect(stopSection).toContain(
      "registerLongAuthenticatedRoute(\n    app,\n    '/sessions/:id/stop'"
    );
    expect(stopSection).not.toContain(
      "registerAuthenticatedRoute(\n    app,\n    '/sessions/:id/stop'"
    );
  });
});
