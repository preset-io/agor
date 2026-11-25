import { cleanup, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import ReactFlow, { type Node, ReactFlowProvider } from 'reactflow';
import 'reactflow/dist/style.css';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { ZoneNode } from './BoardObjectNodes';
import { DEFAULT_BOARD_OBJECT_Z_INDEX, selectedZIndex } from './zOrder';

afterEach(cleanup);

const CONNECTED = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
  authGeneration: 1,
};

// Stand-in for any higher-layer board object (markdown, app, artifact).
function CoverNode() {
  return <div data-testid="cover" style={{ width: 600, height: 400 }} />;
}

const nodeTypes = { zone: ZoneNode, markdown: CoverNode };

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider value={CONNECTED}>
      <AntApp>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </AntApp>
    </ConnectionProvider>
  );
}

it('paints the selected zone toolbar above a markdown object that covers it', async () => {
  const nodes: Node[] = [
    {
      id: 'zone-1',
      type: 'zone',
      position: { x: 100, y: 200 },
      selected: true,
      zIndex: selectedZIndex(DEFAULT_BOARD_OBJECT_Z_INDEX.zone, true),
      style: { width: 400, height: 300 },
      data: {
        objectId: 'zone-1',
        label: 'My Zone',
        width: 400,
        height: 300,
        x: 100,
        y: 200,
        zIndex: DEFAULT_BOARD_OBJECT_Z_INDEX.zone,
        onReorder: vi.fn(),
      },
    },
    {
      // Covers the band above the zone where its toolbar sits.
      id: 'md-1',
      type: 'markdown',
      position: { x: 0, y: 0 },
      zIndex: DEFAULT_BOARD_OBJECT_Z_INDEX.markdown,
      data: {},
    },
  ];
  render(
    <div style={{ width: 900, height: 800 }}>
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        elevateNodesOnSelect={false}
      />
    </div>,
    { wrapper: Wrapper }
  );

  const toolbar = await screen.findByRole('toolbar', { name: 'Zone actions' });
  const cover = await screen.findByTestId('cover');
  const rect = toolbar.getBoundingClientRect();
  const coverRect = cover.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  // The toolbar sits inside the cover's box, so only stacking decides who wins.
  expect(x).toBeGreaterThan(coverRect.left);
  expect(x).toBeLessThan(coverRect.right);
  expect(y).toBeGreaterThan(coverRect.top);
  expect(y).toBeLessThan(coverRect.bottom);

  const hit = document.elementFromPoint(x, y);
  expect(hit && toolbar.contains(hit)).toBe(true);
});
