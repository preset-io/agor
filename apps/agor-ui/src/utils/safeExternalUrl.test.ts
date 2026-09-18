import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from './safeExternalUrl';

describe('isSafeExternalUrl', () => {
  it.each(['https://agor.live/guide', 'http://example.com', 'mailto:team@agor.live'])(
    'allows %s',
    (url) => expect(isSafeExternalUrl(url)).toBe(true)
  );

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '/relative/path',
    'not a url',
    '',
    null,
    undefined,
  ])('rejects %s', (url) => expect(isSafeExternalUrl(url)).toBe(false));
});
