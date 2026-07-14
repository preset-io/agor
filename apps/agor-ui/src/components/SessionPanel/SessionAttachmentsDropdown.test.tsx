import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_PLACEMENT_OPERATION,
  LINK_PROMOTION_DESTINATION,
} from '../Links/linkUiConstants';
import { SessionAttachmentsDropdown } from './SessionAttachmentsDropdown';

describe('SessionAttachmentsDropdown', () => {
  it.each([
    ['Pin', false],
    ['Unpin', true],
  ])('keeps the concise %s action in the manager, not the header popover', async (action, isPinned) => {
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
    expect(
      screen.queryByRole('button', { name: `${action} preset-io/agor#154` })
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage links' }));
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

  it('scopes pinned-manager counts to pinned links', async () => {
    let openPinnedManager: (() => void) | null = null;
    const shared = {
      source: 'manual' as const,
      ownerScope: 'session' as const,
      navigation: 'external' as const,
    };
    const pinned = {
      ...shared,
      key: 'link:pinned',
      linkId: 'pinned',
      name: 'Pinned runbook',
      targetKey: 'url:https://example.com/pinned',
      category: 'url' as const,
      kind: 'url' as const,
      isPinned: true,
      url: 'https://example.com/pinned',
      href: 'https://example.com/pinned',
    };
    const unpinned = {
      ...shared,
      key: 'link:issue',
      linkId: 'issue',
      name: 'Issue: example/repo#1',
      targetKey: 'url:https://github.com/example/repo/issues/1',
      category: 'issue' as const,
      kind: 'issue' as const,
      isPinned: false,
      url: 'https://github.com/example/repo/issues/1',
      href: 'https://github.com/example/repo/issues/1',
    };

    render(
      <MemoryRouter>
        <SessionAttachmentsDropdown
          items={[pinned, unpinned]}
          onRegisterOpenPinnedManager={(openManager) => {
            openPinnedManager = openManager;
          }}
        />
      </MemoryRouter>
    );

    act(() => openPinnedManager?.());

    expect(await screen.findByRole('dialog', { name: 'Pinned links' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All 1' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Links 1' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Issues/PRs 0' })).toBeInTheDocument();
  });

  it('places the add-link action beside the drawer category filters', async () => {
    render(
      <MemoryRouter>
        <SessionAttachmentsDropdown items={[]} onCreateLink={vi.fn(async () => true)} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open links organizer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage links' }));

    const categoryFilters = await screen.findByRole('radiogroup', {
      name: 'segmented control',
    });
    const addLinkButton = screen.getByRole('button', { name: LINK_ACTION_LABEL.add });
    const categoryRow = categoryFilters.parentElement?.parentElement;

    expect(categoryRow).toContainElement(addLinkButton);

    fireEvent.click(addLinkButton);
    expect(
      await screen.findByPlaceholderText('https://example.com or agor://kb/team/document.md')
    ).toBeInTheDocument();
  });

  it('keeps the action menu visible and promotes uploaded files', async () => {
    const onPlacementAction = vi.fn();
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
          getPlacementActions={() => [
            {
              destination: LINK_PROMOTION_DESTINATION.branch,
              branchId: 'branch-1',
              key: LINK_ACTION_KEY.promoteToBranch,
              label: LINK_ACTION_LABEL.promoteToBranch,
              disabled: false,
              operation: LINK_PLACEMENT_OPERATION.promote,
            },
          ]}
          onPlacementAction={onPlacementAction}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open links organizer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage links' }));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for report.pdf' }));
    fireEvent.click(await screen.findByText(LINK_ACTION_LABEL.promoteToBranch));
    expect(onPlacementAction).toHaveBeenCalledWith(item, {
      destination: LINK_PROMOTION_DESTINATION.branch,
      branchId: 'branch-1',
      key: LINK_ACTION_KEY.promoteToBranch,
      label: LINK_ACTION_LABEL.promoteToBranch,
      disabled: false,
      operation: LINK_PLACEMENT_OPERATION.promote,
    });
  });
});
