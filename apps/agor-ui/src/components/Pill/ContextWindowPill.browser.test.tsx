import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ContextWindowPill } from './Pill';

afterEach(cleanup);

it('returns focus to the percentage when Escape closes the breakdown from raw SDK details', async () => {
  render(
    <ContextWindowPill
      used={22}
      limit={100}
      taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
    />
  );
  const trigger = screen.getByRole('button', {
    name: 'Context window 22% used; show token breakdown',
  });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const rawDetails = await screen.findByRole('button', { name: /Raw SDK Response/ });
  await userEvent.tab();
  expect(document.activeElement).toBe(rawDetails);

  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  await new Promise((resolve) => setTimeout(resolve, 400)); // Let the popover exit animation finish.
  expect(rawDetails).not.toBeVisible();
  expect(document.activeElement).toBe(trigger);
});

it('does not return focus on outside dismissal', async () => {
  render(
    <>
      <ContextWindowPill
        used={22}
        limit={100}
        taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
      />
      <button type="button">Outside</button>
    </>
  );
  const trigger = screen.getByRole('button', { name: /Context window 22% used/ });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('button', { name: /Raw SDK Response/ });

  const outside = screen.getByRole('button', { name: 'Outside' });
  await userEvent.click(outside);
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  expect(document.activeElement).toBe(outside);
});
