import type { AgorClient } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { SessionUsagePopover } from './SessionUsagePopover';

afterEach(cleanup);
it('opens with keyboard or click, never hover, and fetches fresh on reopening', async () => {
  const get = vi.fn().mockResolvedValue({
    usage_summary: { cost: 1.25, total: 30, input: 20, output: 10, cacheRead: 0, cacheCreation: 0 },
  });
  render(
    <SessionUsagePopover
      client={{ service: () => ({ get }) } as unknown as AgorClient}
      sessionId="test"
    />
  );
  const button = screen.getByRole('button', { name: 'Show session usage' });
  await userEvent.hover(button);
  expect(get).not.toHaveBeenCalled();
  await userEvent.tab();
  await userEvent.keyboard('{Enter}');
  await screen.findByText('$1.2500');
  expect(get).toHaveBeenCalledTimes(1);
  await userEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  await userEvent.click(button);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await userEvent.keyboard(' ');
  await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  expect(button.textContent?.trim()).toBe('');
});
