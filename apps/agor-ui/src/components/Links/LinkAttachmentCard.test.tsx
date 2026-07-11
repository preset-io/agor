import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkAttachmentCard } from './LinkAttachmentCard';

describe('LinkAttachmentCard', () => {
  it('renders an Ant Design action and opens the resolved target', () => {
    const onOpenTarget = vi.fn();
    render(
      <LinkAttachmentCard
        kind="url"
        title="Runbook"
        url="https://example.com/runbook"
        compact
        onDark
        onOpenTarget={onOpenTarget}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Runbook' }));
    expect(onOpenTarget).toHaveBeenCalledWith({
      href: 'https://example.com/runbook',
      navigation: 'external',
    });
  });
});
