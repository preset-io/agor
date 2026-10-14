import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ExportConditions = Record<string, string>;

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, string | ExportConditions>;
};

describe('@agor/core package exports', () => {
  // tsup builds ESM only (`format: ['esm']`), so a `.cjs` target never exists
  // in dist and every subpath needs the `default` fallback the rest use.
  it('points every subpath at an ESM build with a default condition', () => {
    const broken = Object.entries(manifest.exports).flatMap(([subpath, target]) => {
      if (typeof target === 'string') return [];
      const problems: string[] = [];
      if (Object.values(target).some((path) => path.endsWith('.cjs'))) {
        problems.push(`${subpath}: targets an unbuilt .cjs file`);
      }
      if (target.default !== target.import) {
        problems.push(`${subpath}: default condition does not match import`);
      }
      return problems;
    });

    expect(broken).toEqual([]);
  });
});
