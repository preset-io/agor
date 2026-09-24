import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const rawDetails = await screen.findByRole('button', { name: /Raw SDK Response/ });
  await act(async () => userEvent.tab());
  expect(document.activeElement).toBe(rawDetails);

  await act(async () => userEvent.keyboard('{Escape}'));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  await new Promise((resolve) => setTimeout(resolve, 400)); // Let the popover exit animation finish.
  expect(rawDetails).not.toBeVisible();
  expect(document.activeElement).toBe(trigger);
  await act(async () => userEvent.keyboard(' '));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
  await act(async () => userEvent.keyboard('{Escape}'));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
});

it('does not reopen from a stationary hover after keyboard dismissal', async () => {
  render(
    <ContextWindowPill
      used={22}
      limit={100}
      taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
    />
  );
  const trigger = screen.getByRole('button', { name: /Context window 22% used/ });
  await act(async () => userEvent.hover(trigger));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
  trigger.focus();
  await act(async () => userEvent.tab());
  expect(screen.getByRole('button', { name: /Raw SDK Response/ })).toHaveFocus();
  await act(async () => userEvent.keyboard('{Escape}'));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
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
  await act(async () => userEvent.keyboard('{Enter}'));
  await screen.findByRole('button', { name: /Raw SDK Response/ });

  const outside = screen.getByRole('button', { name: 'Outside' });
  await act(async () => userEvent.click(outside));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  expect(document.activeElement).toBe(outside);
});
