import type { BoardComment } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { CommentNode, ZoneNode } from './BoardObjectNodes';

const zoneConfigModalRenderSpy = vi.hoisted(() => vi.fn());

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
};
const DISCONNECTED = { ...CONNECTED, connected: false };

function renderZone(
  onReorder: ReturnType<typeof vi.fn>,
  connection: typeof CONNECTED,
  extra?: { selected?: boolean; canEdit?: boolean; onUpdate?: ReturnType<typeof vi.fn> }
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

  it('mounts the settings modal only when the user opens it', () => {
    renderZone(vi.fn(), CONNECTED);

    expect(zoneConfigModalRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('zone-config-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zone settings' }));

    expect(zoneConfigModalRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('zone-config-modal')).toHaveTextContent('Zone settings: My Zone');
  });
});
