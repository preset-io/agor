import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionAttachmentsDropdown } from './SessionAttachmentsDropdown';

describe('SessionAttachmentsDropdown', () => {
  it.each([
    ['Pin', false],
    ['Unpin', true],
  ])('shows a concise %s action for an organizer link', async (action, isPinned) => {
    const onTogglePinned = vi.fn();
    const item = {
      key: 'branch:issue',
      name: 'Issue: preset-io/agor#154',
      targetKey: 'url:https://github.com/preset-io/agor/issues/154',
      category: 'issue' as const,
      kind: 'issue' as const,
      source: 'branch' as const,
      ownerScope: 'branch' as const,
      isPinned,
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
    const pinButton = await screen.findByRole('button', {
      name: `${action} preset-io/agor#154`,
    });
    fireEvent.mouseOver(pinButton);
    expect(await screen.findByText(action)).toBeInTheDocument();
    fireEvent.click(pinButton);
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

  it('does not show an overflow action for an unsupported uploaded-file promotion', async () => {
    const item = {
      key: 'link:file-1',
      linkId: 'file-1',
      name: 'report.pdf',
      targetKey: 'file:report.pdf',
      category: 'pdf' as const,
      kind: 'document' as const,
      source: 'upload' as const,
      ownerScope: 'session' as const,
      isPinned: false,
      filePath: 'report.pdf',
    };

    render(
      <MemoryRouter>
        <SessionAttachmentsDropdown
          items={[item]}
          onTogglePinned={vi.fn()}
          getTeammateActionState={() => ({
            isPromoted: false,
            disabled: true,
            unavailableReason: 'File promotion awaits upload retention support',
          })}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open links organizer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage links' }));

    expect(screen.queryByRole('button', { name: /teammate actions/i })).toBeNull();
    expect(screen.queryByText(/upload retention/i)).toBeNull();
  });
});
