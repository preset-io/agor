// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted zone palette fixtures
import type { Board } from '@agor-live/client';
import { cleanup, render, waitFor } from '@testing-library/react';
import 'reactflow/dist/style.css';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import SessionCanvas from './SessionCanvas';

const zone = (x: number, label: string) => ({
  type: 'zone' as const,
  x,
  y: 0,
  width: 580,
  height: 1400,
  label,
  borderColor: '#1677ff',
  backgroundColor: '#1677ff1a',
});
const board = {
  board_id: 'phone-board',
  name: 'Phone board',
  objects: { 'zone-second': zone(640, 'Second'), 'zone-first': zone(0, 'First') },
} as unknown as Board;

const renderPhoneCanvas = () =>
  render(
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration: 1,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <div style={{ width: 390, height: 600 }}>
        <SessionCanvas readOnly board={board} branches={[]} client={null} height="100%" />
      </div>
    </ConnectionProvider>
  );

const viewport = (container: HTMLElement) => {
  const transform = container.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
  const [, x, y, zoom] =
    transform?.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/) ?? [];
  return { x: Number(x), y: Number(y), zoom: Number(zoom) };
};

beforeEach(() => {
  sessionStorage.clear();
  agorStore.setState({ ...EMPTY_MAPS });
});
afterEach(cleanup);

describe('SessionCanvas view-only first view', () => {
  it('opens fitted to the width of the first zone, from its top, at a readable zoom', async () => {
    const { container } = renderPhoneCanvas();
    await waitFor(() => expect(viewport(container).zoom).toBeLessThan(0.7));
    const { x, y, zoom } = viewport(container);
    expect(zoom).toBeGreaterThanOrEqual(0.6);
    // The first zone's left and top edges sit just inside the screen; the second starts off it.
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(30);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(60);
    expect(x + 640 * zoom).toBeGreaterThan(390);
  });

  it('returns to the viewport remembered for the board', async () => {
    sessionStorage.setItem(
      'agor:canvas-viewport:phone-board',
      JSON.stringify({ x: -120, y: -80, zoom: 0.9 })
    );
    const { container } = renderPhoneCanvas();
    await waitFor(() => expect(viewport(container)).toEqual({ x: -120, y: -80, zoom: 0.9 }));
  });
});

describe('SessionCanvas view-only chrome', () => {
  it('does not mount the minimap or the edit controls', async () => {
    const { container } = renderPhoneCanvas();
    await waitFor(() => expect(container.querySelector('.react-flow__viewport')).not.toBeNull());
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
    expect(container.querySelector('.react-flow__controls')).toBeNull();
  });
});
