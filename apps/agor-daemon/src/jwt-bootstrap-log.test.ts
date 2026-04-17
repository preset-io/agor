/**
 * Source-level regression test for JWT bootstrap log hygiene.
 *
 * The daemon's startup logs previously included the first 16 characters of
 * the loaded JWT secret. Even a 16-char prefix is dangerous — it narrows
 * offline brute-force guesses by 128 bits of entropy. This test asserts
 * the anti-pattern does not return to `src/index.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.ts');

describe('daemon JWT secret bootstrap log', () => {
  const source = readFileSync(indexPath, 'utf8');

  it('does not call .substring(... ) on jwtSecret anywhere', () => {
    // Covers `jwtSecret.substring(` and `${jwtSecret.substring(...)}` etc.
    expect(source).not.toMatch(/jwtSecret\s*\.\s*substring\s*\(/);
    // Also guard against .slice, .substr
    expect(source).not.toMatch(/jwtSecret\s*\.\s*slice\s*\(/);
    expect(source).not.toMatch(/jwtSecret\s*\.\s*substr\s*\(/);
  });

  it('does not interpolate jwtSecret directly into a template literal', () => {
    // Catches ${jwtSecret} with nothing chained onto it (length/hash is fine;
    // raw value is not). We match `${jwtSecret}` and `${jwtSecret }`.
    expect(source).not.toMatch(/\$\{\s*jwtSecret\s*\}/);
  });
});
