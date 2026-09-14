import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidUUID } from './ids';
import { generateId } from './ids.browser';

describe('browser UUIDv7 generation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses getRandomValues and works when randomUUID is unavailable', () => {
    const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(values: T): T => {
      if (values instanceof Uint8Array) values.fill(0x2a);
      return values;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    const id = generateId();

    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(isValidUUID(id)).toBe(true);
  });

  it('fails explicitly when the runtime has no cryptographic entropy source', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => generateId()).toThrow('Secure random number generation is unavailable');
  });
});
