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

  it('fires onReorder exactly once for a mouse gesture (pointerUp only, never click)', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);
    const btn = screen.getByLabelText('Bring to front');
    // A full mouse tap: pointerDown → pointerUp → click. The action runs on
    // pointerUp; the trailing click (detail 1) must NOT also fire it. Some touch
    // engines emit a detail-0 synthesized click on tap too — assert that path is
    // inert as well so touch can't double-step.
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn, { detail: 1 });
    fireEvent.click(btn, { detail: 0 });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith('zone-1', 'front');
  });

  it('fires onReorder exactly once on keyboard activation (Enter / Space)', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);
    const btn = screen.getByLabelText('Bring forward');
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenLastCalledWith('zone-1', 'forward');

    fireEvent.keyDown(btn, { key: ' ' });
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder).toHaveBeenLastCalledWith('zone-1', 'forward');
  });

  it('does not compound keyboard + the click the browser synthesizes after it', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);
    const btn = screen.getByLabelText('Send to back');
    // Real browsers fire a detail-0 click after Enter on a button. onKeyDown
    // handles activation; onClick is inert — so the pair must total ONE call.
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn, { detail: 0 });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith('zone-1', 'back');
  });

  it('does NOT fire onReorder when the mutation gate is closed (disconnected)', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, DISCONNECTED);
    const btn = screen.getByLabelText('Bring to front');
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn, { detail: 0 });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
