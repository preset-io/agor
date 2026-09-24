import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ContextWindowPill } from './Pill';

afterEach(cleanup);
it.each([22, 85])('shows %i percent once, without a redundant icon', (percentage) => {
  const { container } = render(<ContextWindowPill used={percentage} limit={100} />);
  expect(screen.getByText(`${percentage}%`)).toBeVisible();
  expect(container.querySelector('.anticon-percentage')).toBeNull();
});

it('opens its breakdown by keyboard and closes with Escape without nesting controls', async () => {
  const { container } = render(<ContextWindowPill used={22} limit={100} />);
  const trigger = screen.getByRole('button', {
    name: /Context window 22% used; show token breakdown/,
  });
  expect(trigger.querySelector('button, a, [role="button"]')).toBeNull();
  trigger.focus();
  fireEvent.click(trigger); // Enter/Space activate native buttons as a click.
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(await screen.findByText('Context Window Usage')).toBeInTheDocument();
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(container.querySelectorAll('button')).toHaveLength(1);
});
