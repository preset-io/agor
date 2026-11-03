import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkingLine } from './WorkingLine';

const BLINK = '.ant-thought-chain-motion-blink';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(Date.parse('2026-10-14T12:00:12.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shimmers one step with a ticking timer kept out of the status region', () => {
  const { container } = render(
    <WorkingLine step="Running: Bash" startedAt="2026-10-14T12:00:00.000Z" />
  );
  expect(screen.getByRole('status')).toHaveTextContent(/^Running: Bash$/);
  expect(container).toHaveTextContent('Running: Bash· 00:12');
  expect(container.querySelectorAll(BLINK)).toHaveLength(1);
  act(() => vi.advanceTimersByTime(60_000));
  expect(container).toHaveTextContent('· 01:12');
  // The same clock as the turn's timer pill, hours included.
  act(() => vi.advanceTimersByTime(3_600_000));
  expect(container).toHaveTextContent('· 01:01:12');
  expect(screen.getByRole('status')).toHaveTextContent(/^Running: Bash$/);
});

it('names a wait statically, with a warning dot and no timer', () => {
  const { container } = render(
    <WorkingLine step="Waiting for approval · Bash" startedAt="2026-10-14T12:00:00.000Z" waiting />
  );
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for approval · Bash');
  expect(container.querySelector('.ant-badge-status-warning')).not.toBeNull();
  expect(container.querySelector(BLINK)).toBeNull();
  expect(container).not.toHaveTextContent('00:12');
});

it('stops the shimmer under reduced motion while the timer keeps counting', () => {
  const matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...matchMedia(query),
    matches: query === '(prefers-reduced-motion: reduce)',
  })) as typeof window.matchMedia;
  try {
    const { container } = render(
      <WorkingLine step="Working…" startedAt="2026-10-14T12:00:00.000Z" />
    );
    expect(container.querySelector(BLINK)).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(container).toHaveTextContent('Working…· 00:15');
  } finally {
    window.matchMedia = matchMedia;
  }
});
