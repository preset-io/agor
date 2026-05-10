import { describe, expect, it } from 'vitest';
import { isLoopbackBindHost, isLoopbackUrl } from './bind-host.js';

describe('isLoopbackBindHost', () => {
  it.each([
    'localhost',
    'LocalHost',
    'LOCALHOST',
    'localhost.',
    '  localhost  ',
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:127.1.2.3',
  ])('treats %s as loopback', (host) => {
    expect(isLoopbackBindHost(host)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '::',
    '::0',
    '192.168.1.10',
    '10.0.0.1',
    'mybox.local',
    'agor.example.com',
    '::ffff:192.168.1.1',
    '128.0.0.1',
    '126.255.255.255',
  ])('treats %s as non-loopback', (host) => {
    expect(isLoopbackBindHost(host)).toBe(false);
  });
});

describe('isLoopbackUrl', () => {
  it('returns null for empty / undefined / null input', () => {
    expect(isLoopbackUrl(undefined)).toBeNull();
    expect(isLoopbackUrl(null)).toBeNull();
    expect(isLoopbackUrl('')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(isLoopbackUrl('not a url')).toBeNull();
    expect(isLoopbackUrl('://broken')).toBeNull();
  });

  it.each([
    'http://localhost',
    'http://localhost:3030',
    'https://127.0.0.1',
    'http://[::1]:3030',
    'http://[::ffff:127.0.0.1]/path',
  ])('returns true for loopback URL %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    'https://agor.example.com',
    'http://192.168.1.10:3030',
    'http://0.0.0.0:3030',
    'http://[::]:3030',
  ])('returns false for public URL %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});
