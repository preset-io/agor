import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { SessionAttachmentsDropdown } from './SessionAttachmentsDropdown';
import type { SessionLinkWidgetItem } from './sessionLinks';

const items: SessionLinkWidgetItem[] = [
  {
    key: 'github-pr',
    name: 'PR: acme/widgets#12',
    targetKey: 'url:https://github.com/acme/widgets/pull/12',
    kind: 'pr',
    url: 'https://github.com/acme/widgets/pull/12',
    href: 'https://github.com/acme/widgets/pull/12',
  },
  {
    key: 'kb-ref',
    name: 'KB: team/runbooks/links.md',
    targetKey: 'ref:agor://kb/team/runbooks/links.md',
    kind: 'kb_ref',
    refUri: 'agor://kb/team/runbooks/links.md',
    href: '/kb/team/runbooks/links.md',
  },
  {
    key: 'opaque-kb-ref',
    name: 'KB document 01900000',
    targetKey: 'ref:agor://kb/document/01900000-0000-7000-8000-000000000092',
    kind: 'kb_ref',
    refUri: 'agor://kb/document/01900000-0000-7000-8000-000000000092',
  },
];

describe('SessionAttachmentsDropdown', () => {
  it('renders GitHub, KB, and non-routable ref rows and opens routable links', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <AntApp>
        <SessionAttachmentsDropdown items={items} />
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('PR: acme/widgets#12')).toBeInTheDocument();
    expect(screen.getByText('KB: team/runbooks/links.md')).toBeInTheDocument();
    expect(screen.getByText('KB document 01900000')).toBeInTheDocument();

    fireEvent.click(screen.getByText('KB: team/runbooks/links.md'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('/kb/team/runbooks/links.md', '_blank'));

    fireEvent.click(screen.getByText('KB document 01900000'));
    expect(open).toHaveBeenCalledTimes(1);

    open.mockRestore();
  });
});
