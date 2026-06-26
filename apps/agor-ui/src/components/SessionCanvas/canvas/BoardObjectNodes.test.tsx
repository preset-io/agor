import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { ZoneNode } from './BoardObjectNodes';

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
  extra?: { selected?: boolean }
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
        onReorder,
      }}
    />,
    { wrapper }
  );
}

describe('ZoneNode layer toolbar', () => {
  it('exposes the layer buttons with accessible labels', () => {
    renderZone(vi.fn(), CONNECTED);
    expect(screen.getByLabelText('Send to back')).toBeTruthy();
    expect(screen.getByLabelText('Send backward')).toBeTruthy();
    expect(screen.getByLabelText('Bring forward')).toBeTruthy();
    expect(screen.getByLabelText('Bring to front')).toBeTruthy();
  });

  it('fires onReorder via keyboard-style click when the mutation gate is open', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);
    // fireEvent.click produces a synthetic click with detail 0 — the same shape
    // as Enter/Space keyboard activation, which is the path the button must
    // support (pointer events don't fire on keyboard activation).
    fireEvent.click(screen.getByLabelText('Bring to front'));
    expect(onReorder).toHaveBeenCalledWith('zone-1', 'front');
  });

  it('does NOT fire onReorder when the mutation gate is closed (disconnected)', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, DISCONNECTED);
    fireEvent.click(screen.getByLabelText('Bring to front'));
    expect(onReorder).not.toHaveBeenCalled();
  });
});
