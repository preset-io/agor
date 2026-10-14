/**
 * Mobile (compact) settings uses an iOS-style grouped index that drills into the
 * reused section content, replacing the desktop section dropdown. Desktop (md+)
 * keeps its Menu + panel, covered by SettingsModal.nav.test.
 */

import type { User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Grid } from 'antd';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';

vi.mock('./BoardsTable', async () => {
  const { DrillInFrame, useSettingsDrill } = await import('./SettingsDrill');
  // A minimal drill-in table: "New board" opens an in-place editor.
  const BoardsTable = () => {
    const { drill, openDrill } = useSettingsDrill();
    if (drill?.mode === 'create') {
      return (
        <DrillInFrame title="New Board" onSave={() => undefined} saveLabel="Create">
          <div>Board editor</div>
        </DrillInFrame>
      );
    }
    return (
      <div>
        Boards section content
        <button type="button" onClick={() => openDrill({ mode: 'create' })}>
          New board
        </button>
      </div>
    );
  };
  return { BoardsTable };
});
vi.mock('./TeammatesTable', () => ({
  TeammatesTable: () => <div>Teammates section content</div>,
}));

beforeEach(() => {
  // Compact = mobile chrome.
  vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ xs: true });
});

function makeUser(role: string): User {
  return { user_id: `user-${role}`, email: `${role}@agor.live`, name: role, role } as User;
}

function MobileSettings({
  userRole = 'admin',
  initial = 'boards',
}: {
  userRole?: string;
  initial?: string;
}) {
  const [tab, setTab] = useState(initial);
  return (
    <SettingsModal
      open
      onClose={vi.fn()}
      client={null}
      currentUser={makeUser(userRole)}
      activeTab={tab}
      onTabChange={setTab}
    />
  );
}

describe('SettingsModal mobile index', () => {
  it('opens on a grouped index with no section dropdown', () => {
    render(<MobileSettings />);
    expect(screen.queryByLabelText('Settings section')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Boards' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repositories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Agor' })).toBeInTheDocument();
    // Group headings + account identity summary.
    expect(screen.getByText('People')).toBeInTheDocument();
    expect(screen.getByText('Resources')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    // The index itself is not the content yet.
    expect(screen.queryByText('Boards section content')).not.toBeInTheDocument();
  });

  it('drills into a section and back to the index', () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Boards' }));

    expect(screen.getByText('Boards section content')).toBeInTheDocument();
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toBeInTheDocument();

    fireEvent.click(back);
    // Back at the index; content is gone and the rows are shown again.
    expect(screen.queryByText('Boards section content')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repositories' })).toBeInTheDocument();
  });

  it('has no MCP row: MCP servers live in the Marketplace', () => {
    render(<MobileSettings />);
    expect(screen.queryByRole('button', { name: /MCP/i })).not.toBeInTheDocument();
  });

  it('opens a create/edit drill-in in place, with no dialog stacked on the Drawer', async () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Boards' }));
    fireEvent.click(screen.getByRole('button', { name: 'New board' }));

    expect(screen.getByText('Board editor')).toBeInTheDocument();
    // The shell footer drives the editor's Save, inside the same surface.
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    // One dialog: the settings Drawer itself.
    expect(document.querySelectorAll('.ant-modal')).toHaveLength(0);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    // Header Back leaves the (clean) drill-in and the section together.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByText('Board editor')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Repositories' })).toBeInTheDocument();
  });

  it('seeds straight into a deep-linked section (with Back to the index)', () => {
    render(<MobileSettings initial="teammates" />);
    expect(screen.getByText('Teammates section content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('gates rows by role (a viewer sees no Users/Groups)', () => {
    render(<MobileSettings userRole="viewer" />);
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Groups' })).not.toBeInTheDocument();
  });
});
