import type { BoardID, BranchID } from '@agor/core/types';
import type { AgorClient, Board, BoardEntityObject } from '@agor-live/client';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { BranchPlacementModal } from './BranchPlacementModal';
import { makeBranch, renderWithApp } from './testUtils';

const boardId = 'board-a' as BoardID;
const branchId = 'branch-a' as BranchID;
const object: BoardEntityObject = {
  object_id: 'object-a',
  board_id: boardId,
  branch_id: branchId,
  entity_type: 'branch',
  position: { x: 10, y: 10 },
  zone_id: 'zone-a',
  created_at: '',
};
const board: Board = {
  name: 'Test board',
  url: 'http://localhost/ui/b/test/',
  created_by: 'user-a',
  created_at: '2026-10-14T00:00:00.000Z',
  last_updated: '2026-10-14T00:00:00.000Z',
  archived: false,
  board_id: boardId,
  objects: {
    'zone-a': { type: 'zone', label: 'Ready', x: 1000, y: 2000, width: 1000, height: 800 },
    'zone-b': { type: 'zone', label: 'Done', x: 2500, y: 2000, width: 1000, height: 800 },
  },
};
function setup({ denied = false, failPatch = false, getObject = async () => object } = {}) {
  const patch = vi.fn(async () => {
    if (failPatch) throw new Error('Move denied');
    return object;
  });
  const service = vi.fn((name: string) => {
    if (name === 'boards') return { get: vi.fn(async () => board) };
    if (name === 'board-objects')
      return { find: vi.fn(async () => ({ data: [object] })), get: vi.fn(getObject), patch };
    if (name === 'boards/:id/effective-access')
      return { find: vi.fn(async () => ({ capabilities: denied ? [] : ['board.edit'] })) };
    throw new Error(`Unexpected service ${name}`);
  });
  const close = vi.fn();
  renderWithApp(
    <BranchPlacementModal
      client={{ service } as unknown as AgorClient}
      branch={makeBranch({ branch_id: branchId, board_id: boardId })}
      open
      onClose={close}
      afterClose={vi.fn()}
    />
  );
  return { patch, close, service };
}
async function select(label: string, option: string) {
  fireEvent.mouseDown(screen.getByLabelText(label));
  fireEvent.click(await screen.findByText(option, { selector: '.ant-select-item-option-content' }));
}
beforeEach(() => {
  agorStore.setState({ dataAuthority: 'user-a:admin:1' });
  setRealtimeAuthorityScope('user-a:admin:1');
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.setState({ dataAuthority: null });
});

describe('Branch placement', () => {
  it('loads current zone/coordinates and applies clamped coordinates via board-objects', async () => {
    const { patch, close, service } = setup();
    const x = await screen.findByLabelText('X');
    expect((x as HTMLInputElement).value).toBe('10');
    fireEvent.change(x, { target: { value: '9000' } });
    fireEvent.change(screen.getByLabelText('Y'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move branch' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('object-a', {
        zone_id: 'zone-a',
        position: { x: 500, y: 0 },
      })
    );
    expect(close).toHaveBeenCalledOnce();
    expect(service.mock.calls.some(([name]) => name.includes('trigger'))).toBe(false);
  });
  it('moves to another zone at an anchor', async () => {
    const { patch } = setup();
    await screen.findByLabelText('X');
    await select('Zone', 'Done');
    await select('Position', 'Bottom right');
    fireEvent.click(screen.getByRole('button', { name: 'Move branch' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('object-a', {
        zone_id: 'zone-b',
        position: { x: 420, y: 520 },
      })
    );
  });
  it('unpins using absolute canvas coordinates, including negatives', async () => {
    const { patch } = setup();
    await screen.findByLabelText('X');
    await select('Zone', 'No zone (canvas)');
    expect(screen.getByLabelText<HTMLInputElement>('X').value).toBe('1010');
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move branch' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('object-a', {
        zone_id: null,
        position: { x: -10, y: 2010 },
      })
    );
  });
  it('fails closed when board edit access is denied', async () => {
    const { patch } = setup({ denied: true });
    expect(await screen.findByText(/You need board edit access/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Move branch' })).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
  it('keeps the form and draft on a rejected patch', async () => {
    const { close } = setup({ failPatch: true });
    await screen.findByLabelText('X');
    fireEvent.click(screen.getByRole('button', { name: 'Move branch' }));
    expect(await screen.findByText(/Move denied/)).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
  it('does not overwrite placement changed by another caller', async () => {
    const { patch } = setup({ getObject: async () => ({ ...object, zone_id: 'zone-b' }) });
    await screen.findByLabelText('X');
    fireEvent.click(screen.getByRole('button', { name: 'Move branch' }));
    expect(await screen.findByText(/Placement changed while editing/)).not.toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
  it('does not send a pending move after an authority/tenant switch', async () => {
    let resolve!: (value: BoardEntityObject) => void;
    const pending = new Promise<BoardEntityObject>((r) => {
      resolve = r;
    });
    const { patch } = setup({ getObject: () => pending });
    await screen.findByLabelText('X');
    fireEvent.click(screen.getByRole('button', { name: 'Move branch' }));
    await act(async () => {
      setRealtimeAuthorityScope('user-b:admin:2');
      agorStore.setState({ dataAuthority: 'user-b:admin:2' });
      resolve(object);
    });
    expect(patch).not.toHaveBeenCalled();
  });
  it('disables submission for an empty coordinate', async () => {
    setup();
    fireEvent.change(await screen.findByLabelText('X'), { target: { value: '' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move branch' }).disabled).toBe(
      true
    );
  });
});
