import { describe, expect, it } from 'vitest';
import { isDynamicImportLoadError } from './dynamicImportError';

describe('isDynamicImportLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: http://localhost/chunk.tsx',
    'Importing a module script failed.',
    'error loading dynamically imported module',
    'ChunkLoadError: Loading chunk 42 failed',
    'Unable to preload CSS for /assets/chunk.css',
  ])('recognizes browser and bundler load failures: %s', (message) => {
    expect(isDynamicImportLoadError(new TypeError(message))).toBe(true);
  });

  it('does not classify module programming errors as load failures', () => {
    expect(isDynamicImportLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
