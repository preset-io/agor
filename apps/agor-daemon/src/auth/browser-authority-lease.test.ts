import { describe, expect, it } from 'vitest';
import { BrowserAuthorityLease } from './browser-authority-lease.js';

describe('browser authority lease', () => {
  it('expires a hung check at the original deadline and never resurrects on late success', async () => {
    let now = 0;
    const lease = new BrowserAuthorityLease(now, () => now);
    let finish!: () => void;
    now = 30_000;
    const renewal = lease.renew(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    now = 60_000;
    expect(lease.current()).toBe(false);
    finish();
    expect(await renewal).toBe(false);
    expect(lease.current()).toBe(false);
  });
  it('anchors successful renewal to check start rather than completion', async () => {
    let now = 0;
    const lease = new BrowserAuthorityLease(now, () => now);
    now = 30_000;
    expect(
      await lease.renew(async () => {
        now = 59_000;
      })
    ).toBe(true);
    now = 90_000;
    expect(lease.current()).toBe(false);
  });
  it('retires on store failure or disconnect while a successful check is pending', async () => {
    const lease = new BrowserAuthorityLease(0, () => 1);
    expect(
      await lease.renew(async () => {
        throw new Error('DB unavailable');
      })
    ).toBe(false);
    const disconnected = new BrowserAuthorityLease(0, () => 1);
    expect(await disconnected.renew(async () => disconnected.retire())).toBe(false);
  });
});
