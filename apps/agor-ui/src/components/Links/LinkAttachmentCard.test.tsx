import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkAttachmentCard, targetForLinkAttachment } from './LinkAttachmentCard';

describe('targetForLinkAttachment', () => {
  it('routes path-addressed KB refs and leaves opaque KB refs unrouted', () => {
    expect(targetForLinkAttachment({ refUri: 'agor://kb/global/guides/architecture.md' })).toEqual({
      href: '/kb/global/guides/architecture.md',
      navigation: 'spa',
    });
    expect(targetForLinkAttachment({ refUri: 'agor://kb/team/runbooks/one%20two.md' })).toEqual({
      href: '/kb/team/runbooks/one%20two.md',
      navigation: 'spa',
    });
    expect(targetForLinkAttachment({ refUri: 'agor://kb/document/0190a000' })).toBeNull();
    expect(targetForLinkAttachment({ refUri: 'agor://kb/unit/0190a000' })).toBeNull();
  });

  it('only returns external targets for absolute http(s) URLs', () => {
    expect(targetForLinkAttachment({ url: 'https://example.com/file.png' })).toEqual({
      href: 'https://example.com/file.png',
      navigation: 'external',
    });
    expect(targetForLinkAttachment({ url: 'http://example.com/file.png' })).toEqual({
      href: 'http://example.com/file.png',
      navigation: 'external',
    });
    expect(targetForLinkAttachment({ url: 'javascript:alert(1)' })).toBeNull();
    expect(targetForLinkAttachment({ url: 'data:text/html,<script>alert(1)</script>' })).toBeNull();
    expect(targetForLinkAttachment({ url: 'blob:https://example.com/id' })).toBeNull();
    expect(targetForLinkAttachment({ url: 'https://%' })).toBeNull();
    expect(targetForLinkAttachment({ url: '/relative/path' })).toBeNull();
  });
});

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
