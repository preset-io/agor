import type { AgorConfig } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warnDeprecatedAnonymousConfig } from './first-run-admin.js';

describe('warnDeprecatedAnonymousConfig', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let written: string;

  beforeEach(() => {
    written = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('is silent when no daemon block exists', () => {
    warnDeprecatedAnonymousConfig({} as AgorConfig);
    expect(written).toBe('');
  });

  it('is silent when daemon block has no deprecated keys', () => {
    warnDeprecatedAnonymousConfig({ daemon: { port: 3030 } } as AgorConfig);
    expect(written).toBe('');
  });

  it('warns when allowAnonymous is present', () => {
    warnDeprecatedAnonymousConfig({
      daemon: { allowAnonymous: true },
    } as unknown as AgorConfig);
    expect(written).toContain('DEPRECATED CONFIG KEYS DETECTED');
    expect(written).toContain('daemon.allowAnonymous: true');
    expect(written).toContain('admin-credentials');
  });

  it('warns when requireAuth is present', () => {
    warnDeprecatedAnonymousConfig({
      daemon: { requireAuth: false },
    } as unknown as AgorConfig);
    expect(written).toContain('DEPRECATED CONFIG KEYS DETECTED');
    expect(written).toContain('daemon.requireAuth: false');
  });

  it('lists both keys when both are present', () => {
    warnDeprecatedAnonymousConfig({
      daemon: { allowAnonymous: true, requireAuth: false },
    } as unknown as AgorConfig);
    expect(written).toContain('daemon.allowAnonymous: true');
    expect(written).toContain('daemon.requireAuth: false');
  });

  it('fires even when the deprecated value is falsy (key presence is what matters)', () => {
    // Operators who explicitly wrote `allowAnonymous: false` still get the
    // nudge — the key is dead, regardless of its value.
    warnDeprecatedAnonymousConfig({
      daemon: { allowAnonymous: false },
    } as unknown as AgorConfig);
    expect(written).toContain('daemon.allowAnonymous: false');
  });
});
