import { LinkOutlined } from '@ant-design/icons';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PinnedLinkButton } from './PinnedLinkButton';

describe('PinnedLinkButton', () => {
  it('uses native button behavior and keeps the compact label', () => {
    const onOpen = vi.fn();
    render(<PinnedLinkButton label="Runbook" icon={<LinkOutlined />} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open pinned Runbook' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByText('Runbook')).toBeInTheDocument();
  });
});
