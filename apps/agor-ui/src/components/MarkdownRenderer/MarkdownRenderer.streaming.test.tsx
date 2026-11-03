import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('../../hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => motion.reduced,
}));

afterEach(() => {
  cleanup();
  motion.reduced = false;
});

const root = (container: HTMLElement) => container.querySelector('.markdown-content')!;

it('fades streamed words in with a caret, then settles in place without a remount', () => {
  const { container, rerender } = render(
    <MarkdownRenderer content="Streaming words arrive" isStreaming />
  );
  const live = root(container);
  expect(live.querySelectorAll('[data-sd-animate]').length).toBeGreaterThan(0);
  expect((live as HTMLElement).style.getPropertyValue('--streamdown-caret')).not.toBe('');

  rerender(<MarkdownRenderer content="Streaming words arrive" />);
  expect(root(container)).toBe(live);
  expect(live.querySelector('[data-sd-animate]')).toBeNull();
  expect((live as HTMLElement).style.getPropertyValue('--streamdown-caret')).toBe('');
  expect(live).toHaveTextContent('Streaming words arrive');
});

it('shows streamed words at once under reduced motion', () => {
  motion.reduced = true;
  const { container } = render(<MarkdownRenderer content="Streaming words arrive" isStreaming />);
  expect(container.querySelector('[data-sd-animate]')).toBeNull();
  expect(container).toHaveTextContent('Streaming words arrive');
});

it('remounts when finished content is edited, so no stale text survives', () => {
  const { container, rerender } = render(<MarkdownRenderer content={'- one\n- two'} />);
  const before = root(container);
  rerender(<MarkdownRenderer content={'- uno\n- two'} />);
  expect(root(container)).not.toBe(before);
  expect(container).toHaveTextContent('uno');
  expect(container.querySelector('[data-sd-animate]')).toBeNull();
});
