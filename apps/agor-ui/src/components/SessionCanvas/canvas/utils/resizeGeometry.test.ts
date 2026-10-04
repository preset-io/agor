import { describe, expect, it } from 'vitest';
import { persistedResizeRect } from './resizeGeometry';

describe('persistedResizeRect', () => {
  const start = { x: 100, y: 200, width: 500, height: 400 };

  it.each([
    {
      handle: 'left',
      position: { x: 150, y: 200 },
      dimensions: { width: 450, height: 400 },
      pinned: { right: 600, bottom: 600 },
    },
    {
      handle: 'right',
      position: undefined,
      dimensions: { width: 450, height: 400 },
      pinned: { left: 100, bottom: 600 },
    },
    {
      handle: 'top',
      position: { x: 100, y: 250 },
      dimensions: { width: 500, height: 350 },
      pinned: { right: 600, bottom: 600 },
    },
    {
      handle: 'bottom',
      position: undefined,
      dimensions: { width: 500, height: 350 },
      pinned: { left: 100, top: 200 },
    },
    {
      handle: 'top-left',
      position: { x: 150, y: 250 },
      dimensions: { width: 450, height: 350 },
      pinned: { right: 600, bottom: 600 },
    },
    {
      handle: 'top-right',
      position: { x: 100, y: 250 },
      dimensions: { width: 450, height: 350 },
      pinned: { left: 100, bottom: 600 },
    },
    {
      handle: 'bottom-left',
      position: { x: 150, y: 200 },
      dimensions: { width: 450, height: 350 },
      pinned: { right: 600, top: 200 },
    },
    {
      handle: 'bottom-right',
      position: undefined,
      dimensions: { width: 450, height: 350 },
      pinned: { left: 100, top: 200 },
    },
  ])(
    'keeps the opposite edges pinned for the $handle handle',
    ({ position, dimensions, pinned }) => {
      const result = persistedResizeRect(start, position, dimensions);
      const edges = {
        left: result.x,
        top: result.y,
        right: result.x + result.width,
        bottom: result.y + result.height,
      };

      expect(edges).toMatchObject(pinned);
    }
  );
});
