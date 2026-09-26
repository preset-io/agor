import type { User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { OnboardingBanners, type OnboardingBannersProps } from './OnboardingBanners';

const DAY = 24 * 60 * 60 * 1000;
const key = 'agor:user:user-a:onboarding:integrations-snoozed-until:v1';
const user = (id: string) =>
  ({
    user_id: id,
    onboarding_completed: true,
    agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
  }) as User;
const props: OnboardingBannersProps = {
  user: user('user-a'),
  mcpServerCount: 0,
  gatewayChannelCount: 0,
  integrationsHydrated: true,
  canManageMcp: true,
  connectionReady: true,
  credentialVersion: 0,
  onOpenUserSettings: vi.fn(),
  onOpenWorkspaceSettings: vi.fn(),
  onCheckAuth: async () => ({ status: 'authenticated', authenticated: true, method: 'none' }),
};

beforeEach(() => {
  localStorage.clear();
  agorStore.getState().reset();
  agorStore.getState().setAgenticToolSettings([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([0, DAY / 2])(
  'snoozes for 24 hours across mobile-style unmount/remount after %i ms and still honors integration eligibility',
  async (elapsedBeforeRemount) => {
    // Auto-advancing timers add wall time to manual advances and can cross the
    // one-millisecond expiry boundary on a busy runner. Settle probes with act,
    // not findBy's timer-based polling, so only explicit advances move the clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const first = await act(async () => render(<OnboardingBanners {...props} />));
    const snoozedUntil = Date.now() + DAY;
    fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }));
    expect(JSON.parse(localStorage.getItem(key)!)).toBe(snoozedUntil);
    expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
    first.unmount();
    await act(() => vi.advanceTimersByTimeAsync(elapsedBeforeRemount));
    const second = await act(async () => render(<OnboardingBanners {...props} />));
    expect(JSON.parse(localStorage.getItem(key)!)).toBe(snoozedUntil);
    expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(DAY - elapsedBeforeRemount - 1));
    expect(Date.now()).toBe(snoozedUntil - 1);
    expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(Date.now()).toBe(snoozedUntil);
    expect(screen.getByRole('button', { name: 'Maybe later' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }));
    second.rerender(<OnboardingBanners {...props} gatewayChannelCount={1} />);
    await act(() => vi.advanceTimersByTimeAsync(DAY));
    expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
    second.rerender(<OnboardingBanners {...props} />);
    expect(screen.getByRole('button', { name: 'Maybe later' })).toBeInTheDocument();
  }
);

it('does not transfer a user snooze across logout or a different user/workspace identity', async () => {
  const view = render(<OnboardingBanners {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Maybe later' }));
  view.rerender(<OnboardingBanners {...props} user={null} />);
  expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
  view.rerender(<OnboardingBanners {...props} user={user('user-b')} />);
  expect(await screen.findByRole('button', { name: 'Maybe later' })).toBeInTheDocument();
  view.rerender(<OnboardingBanners {...props} />);
  expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
});

it('synchronizes another tab snoozing or clearing storage', async () => {
  render(<OnboardingBanners {...props} />);
  await screen.findByRole('button', { name: 'Maybe later' });
  localStorage.setItem(key, JSON.stringify(Date.now() + DAY));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage })));
  expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
  localStorage.clear();
  act(() =>
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }))
  );
  expect(await screen.findByRole('button', { name: 'Maybe later' })).toBeInTheDocument();
});

it.each(['{}', '"tomorrow"', '1', '1e100', 'null'])(
  'ignores unusable/expired snooze %s',
  async (stored) => {
    localStorage.setItem(key, stored);
    render(<OnboardingBanners {...props} />);
    expect(await screen.findByRole('button', { name: 'Maybe later' })).toBeInTheDocument();
  }
);

it('still dismisses in memory if browser storage writes fail', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage disabled');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<OnboardingBanners {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Maybe later' }));
  expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
});

it('keeps the integrations snooze separate from the permanent credential opt-out', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const check = vi
    .fn<OnboardingBannersProps['onCheckAuth']>()
    .mockResolvedValueOnce({ status: 'authenticated', authenticated: true, method: 'api-key' })
    .mockResolvedValue({ status: 'unauthenticated', authenticated: false, method: 'api-key' });
  const view = render(<OnboardingBanners {...props} onCheckAuth={check} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Maybe later' }));
  view.rerender(<OnboardingBanners {...props} onCheckAuth={check} credentialVersion={1} />);
  fireEvent.click(await screen.findByRole('button', { name: "Don't remind me about Claude Code" }));
  await act(() => vi.advanceTimersByTimeAsync(DAY + 1));
  expect(screen.queryByRole('button', { name: 'Maybe later' })).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(check).toHaveBeenCalledTimes(2);
});
