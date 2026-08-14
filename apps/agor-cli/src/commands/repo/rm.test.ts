import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('repo rm managed deletion boundary', () => {
  it('chooses filesystem intent before one daemon removal and never recursively deletes locally', () => {
    const source = readFileSync(new URL('./rm.ts', import.meta.url), 'utf8');

    expect(source).toContain(
      'reposService.remove(repo.repo_id, { query: { cleanup: deleteFiles } })'
    );
    expect(source.match(/reposService\.remove\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\bfs\.rm\s*\(/);
    expect(source).not.toMatch(/node:fs\/promises/);
  });
});
