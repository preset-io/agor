import type { AgorClient } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionUsagePopover } from './SessionUsagePopover';

afterEach(cleanup);
it('does not fetch on mount or hover; click reveals usage and errors are retryable', async () => {
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({
      usage_summary: {
        cost: 1.25,
        total: 30,
        input: 20,
        output: 10,
        cacheRead: 0,
        cacheCreation: 0,
      },
    });
  const client = { service: () => ({ get }) } as unknown as AgorClient;
  render(<SessionUsagePopover client={client} sessionId="test" />);
  const button = screen.getByRole('button', { name: 'Show session usage' });
  fireEvent.mouseEnter(button);
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(button);
  await screen.findByText('Could not load usage.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('$1.2500');
  expect(get).toHaveBeenCalledTimes(2);
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  expect(get).toHaveBeenCalledTimes(2);
});
