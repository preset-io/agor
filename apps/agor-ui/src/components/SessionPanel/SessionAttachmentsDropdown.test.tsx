import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionAttachmentsDropdown } from './SessionAttachmentsDropdown';

describe('SessionAttachmentsDropdown', () => {
  it('allows a derived branch link to be pinned from the organizer', async () => {
    const onTogglePinned = vi.fn();
    const item = {
      key: 'branch:issue',
      name: 'Issue: preset-io/agor#154',
      targetKey: 'url:https://github.com/preset-io/agor/issues/154',
      category: 'issue' as const,
      kind: 'issue' as const,
      source: 'branch' as const,
      ownerScope: 'branch' as const,
      isPinned: false,
      url: 'https://github.com/preset-io/agor/issues/154',
      href: 'https://github.com/preset-io/agor/issues/154',
      navigation: 'external' as const,
    };
    render(
      <MemoryRouter>
        <SessionAttachmentsDropdown items={[item]} onTogglePinned={onTogglePinned} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open links organizer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin to branch card' }));
    expect(onTogglePinned).toHaveBeenCalledWith(item);
  });

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
