import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trackProductEvent } from './productAnalytics';
import { ACCESS_TOKEN_KEY } from './tokenRefresh';

const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
const token = (id: string) => `header.${btoa(JSON.stringify({ sub: id }))}.signature`;
beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('does nothing before authentication or for a stale account', () => {
  trackProductEvent('alice', { event: 'home.viewed' });
  localStorage.setItem(ACCESS_TOKEN_KEY, token('bob'));
  trackProductEvent('alice', { event: 'home.viewed' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('snapshots credentials, sends only allowlisted payload, suppresses referrers, and never retries', async () => {
  localStorage.setItem(ACCESS_TOKEN_KEY, token('alice'));
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  trackProductEvent('alice', {
    event: 'onboarding.step',
    step: 'done',
    action: 'completion_failed',
  });
  localStorage.setItem(ACCESS_TOKEN_KEY, token('bob'));
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('/analytics/product-events'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token('alice')}` },
      body: JSON.stringify({ event: 'onboarding.step', step: 'done', action: 'completion_failed' }),
      referrerPolicy: 'no-referrer',
    }
  );
});
