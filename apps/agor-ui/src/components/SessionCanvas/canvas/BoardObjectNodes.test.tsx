import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { clampZoneToolbarCenter, ZoneNode } from './BoardObjectNodes';

const zoneConfigModalRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('./ZoneConfigModal', () => ({
  ZoneConfigModal: (props: { zoneName: string }) => {
    zoneConfigModalRenderSpy(props);
    return <div data-testid="zone-config-modal">Configure Zone: {props.zoneName}</div>;
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
    suppressToolbar?: boolean;
    positionableItemCount?: number;
    onArrangeContents?: ReturnType<typeof vi.fn>;
    onJustifyContents?: ReturnType<typeof vi.fn>;
    onUpdate?: ReturnType<typeof vi.fn>;
    layout?: {
      mode: 'manual' | 'auto';
      sortBy?: 'position' | 'title';
      sortDirection?: 'asc' | 'desc';
    };
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
        suppressToolbar: extra?.suppressToolbar,
        positionableItemCount: extra?.positionableItemCount,
        layout: extra?.layout,
        onUpdate: extra?.onUpdate,
        onReorder,
        onArrangeContents: extra?.onArrangeContents,
        onJustifyContents: extra?.onJustifyContents,
      }}
    />,
    { wrapper }
  );
}

function expandExtraLayoutActions() {
  const disclosure = screen.getByRole('button', { name: 'Show more layout actions' });
  fireEvent.pointerUp(disclosure);
  return disclosure;
}

describe('clampZoneToolbarCenter', () => {
  it('preserves an already-visible center and clamps both edges after dynamic expansion', () => {
    expect(clampZoneToolbarCenter(500, 600, 1200)).toBe(500);
    expect(clampZoneToolbarCenter(50, 600, 1200)).toBe(316);
    expect(clampZoneToolbarCenter(1150, 600, 1200)).toBe(884);
  });

  it('centers an over-wide toolbar inside the padded host instead of clipping one edge', () => {
    expect(clampZoneToolbarCenter(700, 900, 700)).toBe(350);
    expect(clampZoneToolbarCenter(42, 0, 0)).toBe(42);
  });

  it('never forwards a non-finite coordinate to the portaled toolbar style', () => {
    expect(clampZoneToolbarCenter(Number.NaN, 400, 1_000)).toBe(500);
    expect(clampZoneToolbarCenter(Number.POSITIVE_INFINITY, 400, 0)).toBe(0);
  });
});

describe('ZoneNode layer toolbar', () => {
  it('dispatches Center in zone once through the direct toolbar production callback', () => {
    const onJustifyContents = vi.fn();
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 2, onJustifyContents });

    expandExtraLayoutActions();
    const button = screen.getByRole('button', { name: 'Center in zone' });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);

    expect(onJustifyContents).toHaveBeenCalledTimes(1);
    expect(onJustifyContents).toHaveBeenCalledWith('zone-1', 'middle');
  });

  it('dispatches vertical centering through an explicit accessible action', () => {
    const onJustifyContents = vi.fn();
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 2, onJustifyContents });

    expandExtraLayoutActions();
    const button = screen.getByRole('button', { name: 'Center contents vertically' });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);

    expect(onJustifyContents).toHaveBeenCalledTimes(1);
    expect(onJustifyContents).toHaveBeenCalledWith('zone-1', 'vertical_middle');
  });

  it('allows a single card or worktree to be tidied while keeping empty zones disabled', () => {
    const onArrangeContents = vi.fn();
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 1, onArrangeContents });

    const tidy = screen.getByRole('button', { name: 'Tidy up contents' });
    expect(tidy).toBeEnabled();
    fireEvent.pointerUp(tidy);
    expect(onArrangeContents).toHaveBeenCalledWith('zone-1');

    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 0 });
    expect(screen.getAllByRole('button', { name: 'Tidy up contents' }).at(-1)).toBeDisabled();
  });

  it('keeps the pre-PR controls visible in one row and discloses only extra layout actions', () => {
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 2 });

    const toolbar = screen.getByRole('toolbar', { name: 'Zone actions' });
    expect(toolbar.parentElement).toBe(document.body);
    expect(toolbar).toHaveStyle({
      position: 'fixed',
      zIndex: '10000',
      transform: 'translate(-50%, -100%)',
      flexWrap: 'nowrap',
      width: 'max-content',
      maxWidth: 'calc(100vw - 32px)',
      overflowX: 'auto',
    });

    // Every control that predates #2540 remains directly visible.
    expect(screen.getByTitle('Change border color')).toBeInTheDocument();
    expect(screen.getByTitle('Change background color')).toBeInTheDocument();
    expect(screen.getByTitle('Lock zone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bring to front' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Smaller label' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Larger label' })).toBeInTheDocument();
    expect(screen.getByTitle('Configure zone')).toBeInTheDocument();
    expect(screen.getByTitle('Delete zone')).toBeInTheDocument();

    // Primary layout controls stay direct; lower-frequency additions expand inline.
    expect(screen.getByRole('button', { name: 'Enable Auto Zone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tidy up contents' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Center in zone' })).not.toBeInTheDocument();
    const disclosure = expandExtraLayoutActions();
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Center in zone' })).toBeInTheDocument();
    expect(toolbar).toHaveStyle({ flexWrap: 'nowrap' });
  });

  it('operates the layout disclosure by keyboard, retains focus, and omits it for empty zones', () => {
    const view = renderZone(vi.fn(), CONNECTED, { positionableItemCount: 1 });
    const disclosure = screen.getByRole('button', { name: 'Show more layout actions' });
    disclosure.focus();
    fireEvent.keyDown(disclosure, { key: 'Enter' });
    fireEvent.click(disclosure, { detail: 0 });
    expect(disclosure).toHaveFocus();
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Justify contents' })).toBeInTheDocument();

    fireEvent.keyDown(disclosure, { key: ' ' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Justify contents' })).not.toBeInTheDocument();

    view.unmount();
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 0 });
    expect(
      screen.queryByRole('button', { name: 'Show more layout actions' })
    ).not.toBeInTheDocument();
  });

  it('exposes the layer buttons with accessible labels', () => {
    renderZone(vi.fn(), CONNECTED);
    expect(screen.getByLabelText('Send to back')).toBeTruthy();
    expect(screen.getByLabelText('Send backward')).toBeTruthy();
    expect(screen.getByLabelText('Bring forward')).toBeTruthy();
    expect(screen.getByLabelText('Bring to front')).toBeTruthy();
  });

  it('does not render single-zone actions when the shared selection toolbar replaces them', () => {
    renderZone(vi.fn(), CONNECTED, { suppressToolbar: true });
    expect(screen.getByLabelText('Zone actions')).toHaveStyle({ display: 'none' });
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

describe('ZoneNode config modal', () => {
  beforeEach(() => {
    zoneConfigModalRenderSpy.mockClear();
  });

  it('mounts the configuration modal only when the user opens it', () => {
    renderZone(vi.fn(), CONNECTED);

    expect(zoneConfigModalRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('zone-config-modal')).not.toBeInTheDocument();

    fireEvent.pointerUp(screen.getByTitle('Configure zone'));

    expect(zoneConfigModalRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('zone-config-modal')).toHaveTextContent('Configure Zone: My Zone');
  });

  it('gives the toolbar and modal the same persisted layout state and update callback', () => {
    const onUpdate = vi.fn();
    renderZone(vi.fn(), CONNECTED, {
      onUpdate,
      layout: { mode: 'auto', sortBy: 'title', sortDirection: 'desc' },
    });

    fireEvent.pointerUp(screen.getByTitle('Configure zone'));
    const modalProps = zoneConfigModalRenderSpy.mock.calls[0][0] as {
      onUpdate: unknown;
      zoneData: { layout?: unknown };
    };
    expect(modalProps.onUpdate).toBe(onUpdate);
    expect(modalProps.zoneData.layout).toEqual({
      mode: 'auto',
      sortBy: 'title',
      sortDirection: 'desc',
    });
  });
});

describe('ZoneNode Auto Zone toolbar toggle', () => {
  it('uses the authoritative zone update callback once and exposes durable toggle state', () => {
    const onUpdate = vi.fn();
    const view = renderZone(vi.fn(), CONNECTED, {
      onUpdate,
      layout: { mode: 'manual', sortBy: 'position', sortDirection: 'asc' },
    });

    const enable = screen.getByRole('button', { name: 'Enable Auto Zone' });
    expect(enable).toHaveAttribute('aria-pressed', 'false');
    const inactiveBorderColor = enable.style.borderColor;
    fireEvent.pointerDown(enable);
    fireEvent.pointerUp(enable);
    fireEvent.click(enable);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({
        layout: expect.objectContaining({
          mode: 'auto',
          sortBy: 'updated',
          sortDirection: 'desc',
        }),
      })
    );

    view.unmount();
    renderZone(vi.fn(), CONNECTED, {
      onUpdate,
      layout: { mode: 'auto', sortBy: 'title', sortDirection: 'desc' },
    });
    const disable = screen.getByRole('button', { name: 'Disable Auto Zone' });
    expect(disable).toHaveAttribute('aria-pressed', 'true');
    expect(disable.style.borderColor).not.toBe(inactiveBorderColor);
    expect(disable.style.border).toBe('');
    expect(disable.style.borderWidth).toBe('1px');
    expect(disable.style.borderStyle).toBe('solid');
  });

  it('is keyboard operable without compounding the synthesized click and retains focus', () => {
    const onUpdate = vi.fn();
    renderZone(vi.fn(), CONNECTED, { onUpdate, layout: { mode: 'manual' } });
    const toggle = screen.getByRole('button', { name: 'Enable Auto Zone' });
    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    fireEvent.click(toggle, { detail: 0 });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not expose a misleading toggle while the multi-selection toolbar owns the UI', () => {
    renderZone(vi.fn(), CONNECTED, {
      suppressToolbar: true,
      layout: { mode: 'auto' },
    });
    expect(screen.queryByRole('button', { name: 'Disable Auto Zone' })).not.toBeInTheDocument();
  });
});

function renderZoneDensity(opts: {
  densityExpandableItemCount: number;
  compactDensityExpandableItemCount: number;
  onSetContentsCompact?: ReturnType<typeof vi.fn>;
  connection?: typeof CONNECTED;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionProvider value={opts.connection ?? CONNECTED}>
      <AntApp>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </AntApp>
    </ConnectionProvider>
  );
  return render(
    <ZoneNode
      selected={true}
      data={{
        objectId: 'zone-1',
        label: 'Review',
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        zIndex: 100,
        densityExpandableItemCount: opts.densityExpandableItemCount,
        compactDensityExpandableItemCount: opts.compactDensityExpandableItemCount,
        onSetContentsCompact: opts.onSetContentsCompact,
      }}
    />,
    { wrapper }
  );
}

describe('ZoneNode density toolbar', () => {
  it('offers "Collapse contents" while any pinned item is still expanded', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({
      densityExpandableItemCount: 3,
      compactDensityExpandableItemCount: 0,
      onSetContentsCompact,
    });

    expandExtraLayoutActions();
    const btn = screen.getByLabelText('Collapse contents');
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);

    expect(onSetContentsCompact).toHaveBeenCalledTimes(1);
    expect(onSetContentsCompact).toHaveBeenCalledWith('zone-1', true);
  });

  it('flips to "Expand contents" only once every pinned item is collapsed', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({
      densityExpandableItemCount: 3,
      compactDensityExpandableItemCount: 3,
      onSetContentsCompact,
    });

    expandExtraLayoutActions();
    const btn = screen.getByLabelText('Expand contents');
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);

    expect(onSetContentsCompact).toHaveBeenCalledWith('zone-1', false);
  });

  it('still collapses a partially collapsed zone, making it uniform in one click', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({
      densityExpandableItemCount: 3,
      compactDensityExpandableItemCount: 2,
      onSetContentsCompact,
    });

    expandExtraLayoutActions();
    expect(screen.queryByLabelText('Expand contents')).toBeNull();
    fireEvent.pointerUp(screen.getByLabelText('Collapse contents'));

    expect(onSetContentsCompact).toHaveBeenCalledWith('zone-1', true);
  });

  it('does not offer an inert control when a zone has no density-expandable entities', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({
      densityExpandableItemCount: 0,
      compactDensityExpandableItemCount: 0,
      onSetContentsCompact,
    });

    expect(screen.queryByLabelText('Collapse contents')).toBeNull();
    expect(screen.queryByLabelText('Expand contents')).toBeNull();
    expect(onSetContentsCompact).not.toHaveBeenCalled();
  });

  it('does not fire when the mutation gate is closed (disconnected)', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({
      densityExpandableItemCount: 2,
      compactDensityExpandableItemCount: 0,
      onSetContentsCompact,
      connection: DISCONNECTED,
    });

    const disclosure = screen.getByRole('button', { name: 'Show more layout actions' });
    fireEvent.pointerDown(disclosure);
    fireEvent.pointerUp(disclosure);
    fireEvent.keyDown(disclosure, { key: 'Enter' });

    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Collapse contents')).toBeNull();
    expect(onSetContentsCompact).not.toHaveBeenCalled();
  });
});
