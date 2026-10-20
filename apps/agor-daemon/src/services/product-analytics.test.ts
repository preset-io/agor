import {
  createAnalyticsLogger,
  resetAnalyticsLoggerForTests,
  setAnalyticsLoggerForTests,
} from '@agor/core/analytics';
import { getCurrentTenantId, runWithTenantContext } from '@agor/core/db';
import type { User, UserID } from '@agor/core/types';
import { ONBOARDING_ANALYTICS_STEPS } from '@agor/core/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductAnalyticsService } from './product-analytics';

const user: User = {
  user_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UserID,
  email: 'never-export@example.test',
  role: 'member',
  created_at: '2026-01-01T00:00:00Z',
};
const recorded = vi.fn();
const service = new ProductAnalyticsService();
const send = (data: unknown) =>
  runWithTenantContext('tenant-a', () => service.create(data, { user }));
beforeEach(() => {
  recorded.mockClear();
  setAnalyticsLoggerForTests({
    isEnabled: () => true,
    track: (...args) => recorded(getCurrentTenantId(), ...args),
  });
});
afterEach(() => {
  resetAnalyticsLoggerForTests();
  vi.restoreAllMocks();
});

it('uses only the authenticated user and ambient tenant, not profile data', async () => {
  await send({ event: 'home.viewed' });
  expect(recorded.mock.calls).toEqual([['tenant-a', 'home.viewed', {}, { userId: user.user_id }]]);
});

it.each(ONBOARDING_ANALYTICS_STEPS)('accepts the real normalized step %s', async (step) => {
  await send({ event: 'onboarding.step', step, action: 'viewed' });
  expect(recorded).toHaveBeenCalledWith(
    'tenant-a',
    'onboarding.step',
    { step, action: 'viewed' },
    { userId: user.user_id }
  );
});

it.each([
  { event: 'auth.login_succeeded' },
  { event: 'home.viewed', userId: 'victim' },
  { event: 'home.viewed', tenant_id: 'tenant-b' },
  { event: 'home.viewed', context: { tenant_id: 'tenant-b' } },
  { event: 'home.viewed', properties: { email: 'private@example.test' } },
  { event: 'home.viewed', token: 'secret' },
  { event: 'home.viewed', query: '?launchCode=secret' },
  { event: 'onboarding.step', step: 'Connect AI', action: 'viewed' },
  { event: 'onboarding.step', step: 'llm', action: 'completed' },
  { event: 'onboarding.step', step: 'done', action: 'skipped' },
  { event: 'onboarding.step', step: 'done', action: 'completion_failed', error: 'secret' },
])('rejects forged identity, non-allowlisted events and content: %j', async (data) => {
  await expect(send(data)).rejects.toThrow();
  expect(recorded).not.toHaveBeenCalled();
});

it('fails closed without an authenticated caller or tenant scope', async () => {
  await expect(
    runWithTenantContext('tenant-a', () => service.create({ event: 'home.viewed' }, {}))
  ).rejects.toThrow('Authentication required');
  await expect(service.create({ event: 'home.viewed' }, { user })).rejects.toThrow(
    'Missing active tenant'
  );
  expect(recorded).not.toHaveBeenCalled();
});

it.each([
  { enabled: false, exclude_events: [] },
  { enabled: true, exclude_events: ['home.*', 'onboarding.*'] },
])('preserves operator controls through the real logger: %j', async (config) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setAnalyticsLoggerForTests(
    await createAnalyticsLogger({
      enabled: config.enabled,
      filters: { exclude_events: config.exclude_events },
      plugins: [{ type: 'stdout', enabled: true }],
    })
  );
  await send({ event: 'home.viewed' });
  await send({ event: 'onboarding.step', step: 'workspace', action: 'viewed' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(log).not.toHaveBeenCalled();
});

it('delivers enabled events through the real logger with only trusted identity and closed properties', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setAnalyticsLoggerForTests(
    await createAnalyticsLogger({
      enabled: true,
      filters: { exclude_events: [] },
      plugins: [{ type: 'stdout', enabled: true }],
    })
  );
  await send({ event: 'onboarding.step', step: 'done', action: 'completed' });
  await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  const event = JSON.parse(String(log.mock.calls[0][0]));
  expect(event.userId).toBe(user.user_id);
  expect(event.context.tenant_id).toBe('tenant-a');
  expect(event.properties).toEqual({
    event_type: 'onboarding.step',
    step: 'done',
    action: 'completed',
  });
  expect(JSON.stringify(event)).not.toContain(user.email);
});
