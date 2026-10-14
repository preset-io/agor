import type { Artifact, Board, User } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactsTable } from './ArtifactsTable';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

const artifact = {
  artifact_id: 'artifact-1',
  name: 'API explorer',
  board_id: 'board-1',
  branch_id: null,
  created_by: 'user-1',
  template: 'static',
  build_status: 'error',
  created_at: '2026-01-01T00:00:00Z',
  archived: false,
} as Artifact;

function setup(
  rows: Artifact[] = [artifact],
  users = new Map([['user-1', { user_id: 'user-1', name: 'Alex Morgan' } as User]])
) {
  const onUpdate = vi.fn();
  const onDelete = vi.fn();
  renderWithSettingsShell(
    <MemoryRouter>
      <ArtifactsTable
        artifactById={new Map(rows.map((row) => [row.artifact_id, row]))}
        boardById={new Map([['board-1', { board_id: 'board-1', name: 'Engineering' } as Board]])}
        branchById={new Map()}
        userById={users}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    </MemoryRouter>
  );
  return { onUpdate, onDelete };
}

describe('ArtifactsTable', () => {
  it('separates board, owner and build; filters by the existing directory', () => {
    setup();
    expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual([
      'Artifact',
      'Board',
      'Owner',
      'Build',
      'Actions',
    ]);
    expect(screen.getByText('Error')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Alex Morgan' } });
    expect(screen.getByText('API explorer')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing owner' } });
    expect(screen.getByText('No matching artifacts')).toBeVisible();
  });

  it('does not invent or resolve missing identities or boards', () => {
    setup([{ ...artifact, board_id: 'hidden-board' as Artifact['board_id'] }], new Map());
    expect(screen.getByText('Unavailable user')).toBeVisible();
    expect(screen.getByText('Unavailable board')).toBeVisible();
    expect(screen.queryByText('user-1')).not.toBeInTheDocument();
    expect(screen.queryByText('hidden-board')).not.toBeInTheDocument();
  });

  it('keeps provenance in the editor and avoids no-op updates', async () => {
    const { onUpdate } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit artifact' }));
    // Drill-in (no stacked dialog): the editor renders in place.
    expect(await screen.findByText(/Source branch: Not recorded/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByText(/Source branch: Not recorded/)).not.toBeInTheDocument()
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('requires confirmation before deleting', async () => {
    const { onDelete } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete artifact' }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(artifact.artifact_id));
  });
});

describe('ArtifactsTable live updates', () => {
  it('keeps a typed draft over a remote rename and saves only the description', async () => {
    const onUpdate = vi.fn();
    const view = (row: Artifact) => (
      <MemoryRouter>
        <ArtifactsTable
          artifactById={new Map([[row.artifact_id, row]])}
          boardById={new Map([['board-1', { board_id: 'board-1', name: 'Engineering' } as Board]])}
          branchById={new Map()}
          userById={new Map()}
          onUpdate={onUpdate}
        />
      </MemoryRouter>
    );
    const rendered = renderWithSettingsShell(view(artifact));
    fireEvent.click(screen.getByRole('button', { name: 'Edit artifact' }));
    fireEvent.change(await screen.findByLabelText('Description'), {
      target: { value: 'My draft' },
    });

    rendered.rerender(view({ ...artifact, name: 'API explorer v2', description: 'Remote edit' }));
    // Neither the draft nor an untouched field follows the record while it is open.
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('My draft'));
    expect(screen.getByLabelText('Name')).toHaveValue(artifact.name);

    // The save leaves the remote rename alone.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate).toHaveBeenCalledWith(artifact.artifact_id, { description: 'My draft' });
  });
});
