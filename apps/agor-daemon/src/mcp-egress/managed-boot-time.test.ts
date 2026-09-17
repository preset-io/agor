import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readManagedBootTimeMs } from './managed-boot-time.js';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

describe('managed suspend-inclusive kernel time', () => {
  it.each([
    ['0.00 0.00\n', 0],
    ['12345.67 987654.32\n', 12_345_670],
  ])('reads only the fixed kernel boot-time source: %s', (text, expected) => {
    vi.mocked(readFileSync).mockReturnValue(text);
    expect(readManagedBootTimeMs()).toBe(expected);
    expect(readFileSync).toHaveBeenLastCalledWith('/proc/uptime', 'utf8');
  });

  it.each([
    '',
    'NaN 0.00',
    'Infinity 0.00',
    '-1.00 0.00',
    '1.1 0.00',
    '1.000 0.00',
    '1.00 0.00 extra',
    '99999999999999999999.00 0.00',
    '1'.repeat(129),
  ])('fails closed on malformed/overflowing kernel input: %s', (text) => {
    vi.mocked(readFileSync).mockReturnValue(text);
    expect(readManagedBootTimeMs).toThrow('clock safety');
  });

  it('does not replace an unavailable kernel clock with wall time', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('synthetic kernel read failure');
    });
    expect(readManagedBootTimeMs).toThrow('clock safety');
  });
});
