import { describe, expect, it } from 'vitest';
import { resolveExternalAppLink } from './externalAppLink';

describe('resolveExternalAppLink', () => {
  it('accepts absolute http(s) URLs and falls back to the link as the label', () => {
    expect(resolveExternalAppLink('https://console.example.test/', 'Open Agor Cloud')).toEqual({
      href: 'https://console.example.test/',
      label: 'Open Agor Cloud',
    });
    expect(resolveExternalAppLink('http://localhost:8424', undefined)).toEqual({
      href: 'http://localhost:8424',
      label: 'http://localhost:8424',
    });
  });

  it.each([
    undefined,
    '',
    'https://',
    'not a url',
    '/relative',
    'javascript:alert(1)',
    'ftp://x.test',
  ])('rejects %j', (link) => {
    expect(resolveExternalAppLink(link, 'Open Agor Cloud')).toBeUndefined();
  });
});
