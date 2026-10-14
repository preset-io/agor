import type { BoardComment } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { CommentNode, ZoneNode } from './BoardObjectNodes';

const zoneConfigModalRenderSpy = vi.hoisted(() => vi.fn());
const { copySpy } = vi.hoisted(() => ({ copySpy: vi.fn(async (_text: string) => true) }));
vi.mock('../../../utils/clipboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/clipboard')>()),
  copyToClipboard: copySpy,
}));

vi.mock('./ZoneConfigModal', () => ({
  ZoneConfigModal: (props: { zoneName: string }) => {
    zoneConfigModalRenderSpy(props);
    return <div data-testid="zone-config-modal">Zone settings: {props.zoneName}</div>;
  },
}));

const CONNECTED = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
  authGeneration: 1,
};
const DISCONNECTED = { ...CONNECTED, connected: false };

function renderZone(
  onReorder: ReturnType<typeof vi.fn>,
  connection: typeof CONNECTED,
  extra?: {
    selected?: boolean;
    canEdit?: boolean;
    onUpdate?: ReturnType<typeof vi.fn>;
    beginBoardWrite?: ReturnType<typeof vi.fn>;
    onDraftLost?: ReturnType<typeof vi.fn>;
  }
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionProvider value={connection}>
      <AntApp>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </AntApp>
    </ConnectionProvider>
  );
  return render(
    <ZoneNode
      selected={extra?.selected ?? true}
      data={{
        objectId: 'zone-1',
        label: 'My Zone',
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        zIndex: 100,
        overlappingZoneCount: 2,
        canEdit: extra?.canEdit,
        onUpdate: extra?.onUpdate,
        onReorder,
        beginBoardWrite: extra?.beginBoardWrite,
        onDraftLost: extra?.onDraftLost,
      }}
    />,
    { wrapper }
  );
}

async function openArrangeMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More zone actions' }));
  const arrange = await screen.findByText('Arrange (2 overlapping)');
  fireEvent.mouseEnter(arrange);
  return screen.findByText('Bring to front');
}

describe('ZoneNode compact toolbar', () => {
  it('keeps common actions top-level and buries layer controls in More', () => {
    renderZone(vi.fn(), CONNECTED);

    expect(screen.getByRole('toolbar', { name: 'Zone actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename zone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zone appearance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lock position and size' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zone settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More zone actions' })).toBeInTheDocument();
    expect(screen.queryByText('Bring to front')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Smaller label')).not.toBeInTheDocument();
  });

  it('runs an arrange action once from the nested More menu', async () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);

    fireEvent.click(await openArrangeMenu());

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith('zone-1', 'front'));
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it('uses native keyboard-focusable buttons for common actions', () => {
    const onUpdate = vi.fn();
    renderZone(vi.fn(), CONNECTED, { onUpdate });

    const lock = screen.getByRole('button', { name: 'Lock position and size' });
    lock.focus();
    expect(lock).toHaveFocus();
    fireEvent.click(lock);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][1]).toMatchObject({ locked: true });
  });

  it('removes mutating controls from the focus order while disconnected', () => {
    renderZone(vi.fn(), DISCONNECTED);
    expect(screen.queryByRole('toolbar', { name: 'Zone actions' })).not.toBeInTheDocument();
  });

  it('does not expose editing chrome to viewers or when unselected', () => {
    const { rerender } = renderZone(vi.fn(), CONNECTED, { canEdit: false });
    expect(screen.queryByRole('toolbar', { name: 'Zone actions' })).not.toBeInTheDocument();

    rerender(
      <ZoneNode
        selected={false}
        data={{
          objectId: 'zone-1',
          label: 'My Zone',
          width: 400,
          height: 300,
          x: 0,
          y: 0,
          canEdit: true,
        }}
      />
    );
    expect(screen.queryByRole('toolbar', { name: 'Zone actions' })).not.toBeInTheDocument();
  });
});

function renderComment(comment: BoardComment) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AntApp>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </AntApp>
  );
  return render(<CommentNode data={{ comment, replyCount: 0 }} />, { wrapper });
}

describe('CommentNode reconnect rehydration', () => {
  // A comment can rehydrate from a partial payload on reconnect before its
  // `content` arrives. Rendering must not throw — a bare string method on
  // `undefined` here would crash the whole SessionPanel via the error boundary.
  it('renders without throwing when content is not yet populated', () => {
    const partial = {
      comment_id: 'comment-1',
      board_id: 'board-1',
      created_by: 'user-1',
      // content intentionally omitted to simulate partial rehydration
      resolved: false,
      created_at: new Date().toISOString(),
    } as unknown as BoardComment;

    expect(() => renderComment(partial)).not.toThrow();
  });
});

describe('ZoneNode settings modal', () => {
  beforeEach(() => {
    zoneConfigModalRenderSpy.mockClear();
  });

  it('writes from the settings dialog and the label editor under the ticket captured when they opened', () => {
    const opened = { boardId: 'board-1', generation: null, authGeneration: 1 };
    const later = { boardId: 'board-1', generation: null, authGeneration: 2 };
    const beginBoardWrite = vi.fn().mockReturnValueOnce(opened).mockReturnValue(later);
    const onUpdate = vi.fn();
    renderZone(vi.fn(), CONNECTED, { onUpdate, beginBoardWrite });

    fireEvent.click(screen.getByRole('button', { name: 'Zone settings' }));
    const modalProps = zoneConfigModalRenderSpy.mock.calls.at(-1)?.[0] as {
      onUpdate: (objectId: string, objectData: unknown) => unknown;
    };
    modalProps.onUpdate('zone-1', { type: 'zone', label: 'Renamed' });
    expect(onUpdate).toHaveBeenLastCalledWith('zone-1', { type: 'zone', label: 'Renamed' }, opened);

    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    const input = screen.getByDisplayValue('My Zone');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onUpdate.mock.calls.at(-1)?.[2]).toBe(later);
    expect(beginBoardWrite).toHaveBeenCalledTimes(2);
  });

  it('keeps a label draft rejected by a board reload to copy or discard, never under a new ticket', async () => {
    copySpy.mockClear();
    const opened = { boardId: 'board-1', generation: null, authGeneration: 1 };
    const fresh = { boardId: 'board-1', generation: null, authGeneration: 2 };
    const beginBoardWrite = vi.fn().mockReturnValueOnce(opened).mockReturnValue(fresh);
    const onUpdate = vi.fn().mockResolvedValueOnce('stale').mockResolvedValue(true);
    renderZone(vi.fn(), CONNECTED, { onUpdate, beginBoardWrite });

    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    const input = screen.getByDisplayValue('My Zone');
    fireEvent.change(input, { target: { value: 'Draft label' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(
      await screen.findByText(/The board reloaded, so your changes weren't saved\./)
    ).toBeTruthy();
    expect(screen.getByDisplayValue('Draft label')).toBeTruthy();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][2]).toBe(opened);
    expect(screen.queryByRole('button', { name: 'Re-apply to reloaded board' })).toBeNull();
    // Neither leaving the editor, Enter, nor a re-open click retries or
    // captures a new ticket.
    fireEvent.blur(screen.getByDisplayValue('Draft label'));
    fireEvent.keyDown(screen.getByDisplayValue('Draft label'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(beginBoardWrite).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledExactlyOnceWith('Draft label'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(
      screen.queryByText(/The board reloaded, so your changes weren't saved\./)
    ).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Draft label')).not.toBeInTheDocument();
    expect(screen.getByText('My Zone')).toBeTruthy();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(beginBoardWrite).toHaveBeenCalledTimes(1);

    // Reopening the editor captures a new ticket at open.
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    const reopened = screen.getByDisplayValue('My Zone');
    fireEvent.change(reopened, { target: { value: 'Renamed again' } });
    fireEvent.keyDown(reopened, { key: 'Enter' });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1][1]).toMatchObject({ label: 'Renamed again' });
    expect(onUpdate.mock.calls[1][2]).toBe(fresh);
  });

  it('hands an unsaved label or settings draft to the canvas when the node unmounts', () => {
    const onDraftLost = vi.fn();
    const beginBoardWrite = vi.fn(() => ({ boardId: 'board-1', generation: null }));
    const unchanged = renderZone(vi.fn(), CONNECTED, { onDraftLost, beginBoardWrite });
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    unchanged.unmount();
    expect(onDraftLost).not.toHaveBeenCalled();

    const view = renderZone(vi.fn(), CONNECTED, { onDraftLost, beginBoardWrite });
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    fireEvent.change(screen.getByDisplayValue('My Zone'), { target: { value: 'Draft label' } });
    view.unmount();
    expect(onDraftLost).toHaveBeenCalledExactlyOnceWith({
      objectId: 'zone-1',
      zoneName: 'My Zone',
      text: 'Label: Draft label',
    });

    onDraftLost.mockClear();
    const dialog = renderZone(vi.fn(), CONNECTED, { onDraftLost, beginBoardWrite });
    fireEvent.click(screen.getByRole('button', { name: 'Zone settings' }));
    const { draftReaderRef } = (zoneConfigModalRenderSpy.mock.lastCall?.[0] ?? {}) as {
      draftReaderRef: { current: (() => string | null) | null };
    };
    draftReaderRef.current = () => 'Prompt template:\nUnsaved';
    dialog.unmount();
    expect(onDraftLost).toHaveBeenCalledExactlyOnceWith({
      objectId: 'zone-1',
      zoneName: 'My Zone',
      text: 'Prompt template:\nUnsaved',
    });
  });

  it('keeps a label draft committed while the board is read-only, and refuses it once its partition ended', async () => {
    const owner = { alive: true };
    // A partition generation the store no longer holds: the board unloaded.
    const ended = { boardId: 'board-1', generation: -1, authGeneration: 0, owner };
    const onUpdate = vi.fn();
    const onDraftLost = vi.fn();
    const zone = (canEdit: boolean) => (
      <ZoneNode
        selected
        data={{
          objectId: 'zone-1',
          label: 'My Zone',
          width: 400,
          height: 300,
          x: 0,
          y: 0,
          canEdit,
          onUpdate,
          onDraftLost,
          beginBoardWrite: vi.fn(() => ended) as never,
        }}
      />
    );
    const view = renderZone(vi.fn(), CONNECTED, {
      onUpdate,
      onDraftLost,
      beginBoardWrite: vi.fn(() => ended),
      canEdit: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    fireEvent.change(screen.getByDisplayValue('My Zone'), { target: { value: 'Draft label' } });
    view.rerender(zone(false));
    fireEvent.blur(screen.getByDisplayValue('Draft label'));

    expect(
      await screen.findByText(/The board reloaded, so your changes weren't saved\./)
    ).toBeTruthy();
    expect(screen.getByDisplayValue('Draft label')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy draft' })).toBeTruthy();
    // The reload brings edit back: the draft still never saves.
    view.rerender(zone(true));
    fireEvent.keyDown(screen.getByDisplayValue('Draft label'), { key: 'Enter' });
    expect(onUpdate).not.toHaveBeenCalled();
    // The reload deleted the zone: the draft goes to the canvas.
    view.unmount();
    expect(onDraftLost).toHaveBeenCalledExactlyOnceWith({
      objectId: 'zone-1',
      zoneName: 'My Zone',
      text: 'Label: Draft label',
    });
  });

  it('keeps a label draft committed while edit is withheld, then saves it under its ticket', () => {
    // A ticket whose partition lifetime holds (no partition required).
    const opened = {
      boardId: 'board-1',
      generation: null,
      authGeneration: 1,
      owner: { alive: true },
    };
    const onUpdate = vi.fn();
    const zone = (canEdit: boolean) => (
      <ZoneNode
        selected
        data={{
          objectId: 'zone-1',
          label: 'My Zone',
          width: 400,
          height: 300,
          x: 0,
          y: 0,
          canEdit,
          onUpdate,
          beginBoardWrite: vi.fn(() => opened) as never,
        }}
      />
    );
    const view = renderZone(vi.fn(), CONNECTED, {
      onUpdate,
      beginBoardWrite: vi.fn(() => opened),
      canEdit: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    fireEvent.change(screen.getByDisplayValue('My Zone'), { target: { value: 'Draft label' } });
    view.rerender(zone(false));
    fireEvent.keyDown(screen.getByDisplayValue('Draft label'), { key: 'Enter' });
    expect(screen.getByDisplayValue('Draft label')).toBeTruthy();
    expect(
      screen.queryByText(/The board reloaded, so your changes weren't saved\./)
    ).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();

    view.rerender(zone(true));
    fireEvent.keyDown(screen.getByDisplayValue('Draft label'), { key: 'Enter' });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][1]).toMatchObject({ label: 'Draft label' });
    expect(onUpdate.mock.calls[0][2]).toBe(opened);
  });

  it('an open zone dialog ignores a second open click and keeps its open-time ticket', async () => {
    const opened = { boardId: 'board-1', generation: null, authGeneration: 1 };
    const later = { boardId: 'board-1', generation: null, authGeneration: 2 };
    const beginBoardWrite = vi.fn().mockReturnValueOnce(opened).mockReturnValue(later);
    const onUpdate = vi.fn();
    renderZone(vi.fn(), CONNECTED, { onUpdate, beginBoardWrite });

    fireEvent.click(screen.getByRole('button', { name: 'Zone settings' }));
    // A second click (double click) and the delete dialog's opener, while the
    // settings dialog is open.
    fireEvent.click(screen.getByRole('button', { name: 'Zone settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'More zone actions' }));
    fireEvent.click(await screen.findByText('Delete zone'));
    expect(beginBoardWrite).toHaveBeenCalledTimes(1);
    const modalProps = zoneConfigModalRenderSpy.mock.calls.at(-1)?.[0] as {
      onUpdate: (objectId: string, objectData: unknown) => unknown;
    };
    modalProps.onUpdate('zone-1', { type: 'zone', label: 'Renamed' });
    expect(onUpdate).toHaveBeenLastCalledWith('zone-1', { type: 'zone', label: 'Renamed' }, opened);
  });

  it('mounts the settings modal only when the user opens it', () => {
    renderZone(vi.fn(), CONNECTED);

    expect(zoneConfigModalRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('zone-config-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zone settings' }));

    expect(zoneConfigModalRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('zone-config-modal')).toHaveTextContent('Zone settings: My Zone');
  });
});
