import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThinkingBlock } from './ThinkingBlock';

const BLINK = '.ant-thought-chain-motion-blink';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(100_000);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function preferReducedMotion() {
  const matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...matchMedia(query),
    matches: query === '(prefers-reduced-motion: reduce)',
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = matchMedia;
  };
}

it('escalates the live label on the copy steps and announces only step changes', () => {
  const { container } = render(<ThinkingBlock content="" isStreaming startedAt={100_000} />);
  const header = screen.getByRole('button', { name: 'Thinking…', expanded: false });
  expect(header).toHaveTextContent('Thinking…· 00:00');
  expect(screen.getByRole('status')).toHaveTextContent(/^Thinking…$/);
  expect(container.querySelector(BLINK)).not.toBeNull();

  act(() => vi.advanceTimersByTime(14_000));
  expect(header).toHaveTextContent('· 00:14');
  expect(screen.getByRole('status')).toHaveTextContent(/^Thinking…$/);

  for (const [seconds, label] of [
    [15, 'Still thinking…'],
    [30, 'Thinking more…'],
    [45, 'Thinking some more…'],
    [72, 'Almost done thinking…'],
  ] as const) {
    act(() => vi.setSystemTime(100_000 + seconds * 1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: label })).toBe(header);
    expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${label}$`));
  }
  expect(header).toHaveTextContent('· 01:13');
});

it('settles to a quiet "Thought for" line that expands the reasoning', () => {
  const { container, rerender } = render(
    <ThinkingBlock content="Saved reasoning" isStreaming startedAt={100_000} />
  );
  rerender(
    <ThinkingBlock
      content="Saved reasoning"
      isStreaming={false}
      startedAt={100_000}
      endedAt={172_000}
    />
  );
  const header = screen.getByRole('button', { name: 'Thought for 1m 12s', expanded: false });
  expect(container.querySelector(BLINK)).toBeNull();
  expect(screen.queryByText('Saved reasoning')).not.toBeInTheDocument();
  fireEvent.click(header);
  expect(header).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Saved reasoning')).toBeVisible();
});

it('reads "Thought for a while" for history without a live region', () => {
  render(<ThinkingBlock content="Saved reasoning" />);
  expect(screen.getByRole('button', { name: 'Thought for a while' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('keeps the timer counting but drops the shimmer under reduced motion', () => {
  const restore = preferReducedMotion();
  try {
    const { container } = render(<ThinkingBlock content="" isStreaming startedAt={100_000} />);
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('button', { name: 'Still thinking…' })).toHaveTextContent('· 00:20');
    expect(container.querySelector(BLINK)).toBeNull();
  } finally {
    restore();
  }
});
