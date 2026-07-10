import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionAttachmentsDropdown } from './SessionAttachmentsDropdown';

describe('SessionAttachmentsDropdown', () => {
  it('keeps link-load failures visible and retryable when no items loaded', async () => {
    const onRetry = vi.fn();
    render(
      <MemoryRouter>
        <SessionAttachmentsDropdown
          items={[]}
          error="Failed to load links: access denied"
          onRetry={onRetry}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open links organizer' }));
    expect(await screen.findByText('Failed to load links: access denied')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows a loading organizer instead of disappearing', async () => {
    render(
      <MemoryRouter>
        <SessionAttachmentsDropdown items={[]} loading />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open links organizer' }));
    expect(await screen.findByText('Loading links…')).toBeInTheDocument();
  });
});
