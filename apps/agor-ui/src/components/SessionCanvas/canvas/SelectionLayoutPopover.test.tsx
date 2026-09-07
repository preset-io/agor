import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  CANVAS_LAYOUT_CONTROLS_CLASS,
  SelectionLayoutPopover,
  selectionBoardZoneArrangementOptions,
  selectionGridTracks,
} from './SelectionLayoutPopover';

describe('selectionGridTracks', () => {
  it('derives the opposite track count without creating empty required tracks', () => {
    expect(selectionGridTracks(7, 'columns', 3)).toEqual({ columns: 3, rows: 3 });
    expect(selectionGridTracks(7, 'rows', 2)).toEqual({ columns: 4, rows: 2 });
    expect(selectionGridTracks(2, 'columns', 20)).toEqual({ columns: 2, rows: 1 });
  });
});

describe('selectionBoardZoneArrangementOptions', () => {
  it('maps columns, rows, and final-row distribution into the shared zone planner', () => {
    expect(
      selectionBoardZoneArrangementOptions(7, {
        mode: 'grid',
        trackAxis: 'columns',
        trackCount: 2,
        matchRowHeights: false,
        matchColumnWidths: true,
        rowDistribution: 'packed',
        density: 'preserve',
      })
    ).toEqual({
      mode: 'grid',
      fixedItemsPerRow: 2,
      compactFixedGrid: true,
      justifyRows: false,
      justifyLastRow: false,
      matchRowHeights: false,
      matchColumnWidths: true,
      resizeZoneFrames: true,
      density: 'preserve',
    });
    expect(
      selectionBoardZoneArrangementOptions(7, {
        mode: 'grid',
        trackAxis: 'rows',
        trackCount: 2,
        matchRowHeights: true,
        matchColumnWidths: false,
        rowDistribution: 'justify',
        density: 'collapse',
      })
    ).toEqual({
      mode: 'grid',
      fixedItemsPerRow: 4,
      compactFixedGrid: true,
      justifyRows: true,
      justifyLastRow: true,
      matchRowHeights: true,
      matchColumnWidths: false,
      resizeZoneFrames: true,
      density: 'collapse',
    });
  });

  it('uses the exact ordinary Arrange options for compact or toolbar arrange', () => {
    expect(selectionBoardZoneArrangementOptions(3)).toEqual({
      mode: 'grid',
      justifyRows: true,
      resizeZoneFrames: true,
      matchRowHeights: true,
      matchColumnWidths: true,
      density: 'preserve',
    });
    expect(
      selectionBoardZoneArrangementOptions(3, {
        mode: 'compact',
        trackAxis: 'columns',
        trackCount: 2,
        matchRowHeights: false,
        matchColumnWidths: false,
        rowDistribution: 'packed',
        density: 'expand',
      })
    ).toEqual({ mode: 'compact', density: 'expand' });
  });
});

describe('SelectionLayoutPopover', () => {
  it('keeps the shared justified grid as the ordinary default and exposes compact controls', async () => {
    const onApply = vi.fn();
    render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={7} zoneOnlySelection={false} onApply={onApply} />
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    expect(await screen.findByLabelText('Fixed grid axis')).toBeInTheDocument();
    const gridControl = screen.getByText('Grid');
    expect(gridControl.closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    expect(screen.getByText('3 columns × 3 rows')).toBeInTheDocument();
    expect(screen.getByText('Preserve current expansion')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Match heights within rows'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout', hidden: true }));

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        mode: 'grid',
        trackAxis: 'columns',
        trackCount: 3,
        matchRowHeights: true,
        matchColumnWidths: false,
        rowDistribution: 'packed',
        density: 'preserve',
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByText('Compact'));
    expect(await screen.findByText(/smallest stable, collision-free cluster/i)).toBeInTheDocument();
  });

  it('applies an explicit density choice and resets to Preserve when reopened', async () => {
    const onApply = vi.fn();
    render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={2} zoneOnlySelection={false} onApply={onApply} />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Content expansion' }));
    fireEvent.click(await screen.findByText('Collapse eligible contents'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout', hidden: true }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ density: 'collapse' }));

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    expect(screen.getByText('Preserve current expansion')).toBeInTheDocument();
  });

  it('explains an ineligible selection and can only submit Preserve', async () => {
    const onApply = vi.fn();
    render(
      <AntApp>
        <SelectionLayoutPopover
          selectionCount={2}
          zoneOnlySelection={false}
          densityAvailable={false}
          onApply={onApply}
        />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    expect(screen.getByRole('combobox', { name: 'Content expansion' })).toBeDisabled();
    expect(
      screen.getByText(/selection has no worktrees or cards with body content/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout', hidden: true }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ density: 'preserve' }));
  });

  it('tracks the compact three-column default as a selection grows without overriding edits', async () => {
    const onApply = vi.fn();
    const view = render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={2} zoneOnlySelection={false} onApply={onApply} />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByText('Grid'));
    expect(screen.getByText('2 columns × 1 row')).toBeInTheDocument();

    view.rerender(
      <AntApp>
        <SelectionLayoutPopover selectionCount={9} zoneOnlySelection={false} onApply={onApply} />
      </AntApp>
    );
    expect(await screen.findByText('3 columns × 3 rows')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Number of columns'), { target: { value: '4' } });
    view.rerender(
      <AntApp>
        <SelectionLayoutPopover selectionCount={10} zoneOnlySelection={false} onApply={onApply} />
      </AntApp>
    );
    expect(await screen.findByText('4 columns × 3 rows')).toBeInTheDocument();
  });

  it('defaults honest zone-only grid frame matching on and explains the preserved-size option', async () => {
    const onApply = vi.fn();
    render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={3} zoneOnlySelection onApply={onApply} />
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByText('Grid', { exact: true }));
    const matching = screen.getByRole('switch', { name: 'Match zone frames to grid' });
    expect(matching).toBeChecked();
    expect(screen.getByText(/can leave extra space inside larger tracks/i)).toBeInTheDocument();
    fireEvent.click(matching);
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout', hidden: true }));

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({ matchRowHeights: false, matchColumnWidths: false })
      )
    );
  });
});
