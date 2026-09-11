import { describe, expect, it } from 'vitest';
import {
  boardLayoutContextOptions,
  boardZoneArrangementOptions,
  DEFAULT_BOARD_LAYOUT_SETTINGS,
  normalizeBoardLayoutSettings,
} from './board-layout-options';

describe('shared board layout settings', () => {
  it('normalizes one default contract for board and select-all callers', () => {
    const board = boardZoneArrangementOptions(DEFAULT_BOARD_LAYOUT_SETTINGS, 7);
    const selection = boardZoneArrangementOptions(undefined, 7);
    expect(selection).toEqual(board);
    expect(selection).toMatchObject({
      mode: 'grid',
      density: 'preserve',
      gapX: 64,
      gapY: 48,
      outerMargin: 96,
      packZoneContents: true,
      resizeZoneFrames: true,
      justifyRows: true,
    });
    expect(selection.fixedItemsPerRow).toBeUndefined();
  });

  it('translates rows into exact columns without duplicating planner defaults', () => {
    expect(
      boardZoneArrangementOptions(
        normalizeBoardLayoutSettings({ trackAxis: 'rows', trackCount: 2 }, 7),
        7
      )
    ).toMatchObject({ fixedItemsPerRow: 4, compactFixedGrid: true });
  });

  it('preserves exact axis spacing and reads the legacy scalar without persisting it', () => {
    expect(
      normalizeBoardLayoutSettings({ columnGap: 37.5, rowGap: 53.25, outerMargin: 91.5 }, 5)
    ).toMatchObject({ columnGap: 37.5, rowGap: 53.25, outerMargin: 91.5 });
    expect(normalizeBoardLayoutSettings({ gap: 27.75 }, 5)).toMatchObject({
      columnGap: 27.75,
      rowGap: 27.75,
    });
    expect(normalizeBoardLayoutSettings({ gap: 27.75 }, 5)).not.toHaveProperty('gap');
  });

  it('round-trips active cell alignment through the shared settings contract', () => {
    const settings = normalizeBoardLayoutSettings(
      { cellHorizontalAlignment: 'end', cellVerticalAlignment: 'center' },
      5
    );
    expect(settings).toMatchObject({
      cellHorizontalAlignment: 'end',
      cellVerticalAlignment: 'center',
    });
    expect(boardZoneArrangementOptions(settings, 5)).toMatchObject({
      cellHorizontalAlignment: 'end',
      cellVerticalAlignment: 'center',
    });
  });

  it('rehydrates Auto tracks from persisted cells instead of a new viewport', () => {
    expect(
      boardLayoutContextOptions({
        scope: 'selection',
        root_ids: ['a', 'b', 'c', 'd', 'e'],
        settings: normalizeBoardLayoutSettings({ trackAxis: 'auto' }, 5),
        cells: {
          a: { x: 0, y: 0, width: 100, height: 100, row: 0, column: 0 },
          b: { x: 120, y: 0, width: 100, height: 100, row: 0, column: 1 },
          c: { x: 240, y: 0, width: 100, height: 100, row: 0, column: 2 },
          d: { x: 0, y: 120, width: 100, height: 100, row: 1, column: 0 },
          e: { x: 120, y: 120, width: 100, height: 100, row: 1, column: 1 },
        },
      })
    ).toMatchObject({ fixedItemsPerRow: 3, compactFixedGrid: true });
  });
});
