import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { ZoneNode } from './BoardObjectNodes';

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
  extra?: {
    selected?: boolean;
    canEdit?: boolean;
    onUpdate?: ReturnType<typeof vi.fn>;
    data?: Record<string, unknown>;
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
        ...extra?.data,
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

  it('keeps layout actions in More instead of widening the toolbar', async () => {
    const onArrangeContents = vi.fn();
    const onSetContentsCompact = vi.fn();
    renderZone(vi.fn(), CONNECTED, {
      data: {
        positionableItemCount: 2,
        densityExpandableItemCount: 2,
        compactDensityExpandableItemCount: 1,
        onArrangeContents,
        onSetContentsCompact,
      },
    });

    expect(screen.queryByRole('button', { name: 'Tidy up contents' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More zone actions' }));
    fireEvent.click(await screen.findByText('Tidy up contents'));
    expect(onArrangeContents).toHaveBeenCalledWith('zone-1');

    fireEvent.click(screen.getByRole('button', { name: 'More zone actions' }));
    const expansion = await screen.findByText('Content expansion');
    fireEvent.mouseEnter(expansion);
    fireEvent.click(await screen.findByText('Collapse eligible contents'));
    expect(onSetContentsCompact).toHaveBeenCalledWith('zone-1', true);
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
