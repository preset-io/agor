import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  CANVAS_LAYOUT_CONTROLS_CLASS,
  SelectionLayoutPopover,
  selectionBoardZoneArrangementOptions,
  selectionGridTracks,
} from './SelectionLayoutPopover';

describe('selection grid compatibility helpers', () => {
  it('derives the opposite track count without empty tracks', () => {
    expect(selectionGridTracks(7, 'columns', 3)).toEqual({ columns: 3, rows: 3 });
    expect(selectionGridTracks(7, 'rows', 2)).toEqual({ columns: 4, rows: 2 });
    expect(selectionGridTracks(2, 'columns', 20)).toEqual({ columns: 2, rows: 1 });
  });

  it('routes every setting through the shared core translator', () => {
    expect(
      selectionBoardZoneArrangementOptions(7, {
        mode: 'grid',
        trackAxis: 'rows',
        trackCount: 2,
        matchRowHeights: true,
        matchColumnWidths: false,
        density: 'collapse',
        columnGap: 24,
        rowGap: 20,
        outerMargin: 72,
        packZoneContents: true,
        resizeZoneFrames: true,
        justifyRows: true,
        lastRow: 'justify',
      })
    ).toEqual({
      mode: 'grid',
      fixedItemsPerRow: 4,
      compactFixedGrid: true,
      justifyRows: true,
      justifyLastRow: true,
      lastRowAlignment: 'start',
      matchRowHeights: true,
      matchColumnWidths: false,
      resizeZoneFrames: true,
      packZoneContents: true,
      density: 'collapse',
      gapX: 24,
      gapY: 20,
      outerMargin: 72,
    });
  });
});

describe('SelectionLayoutPopover', () => {
  it('renders the shared production editor and submits its normalized payload', () => {
    const onApply = vi.fn();
    render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={7} zoneOnlySelection={false} onApply={onApply} />
      </AntApp>
    );

    const trigger = screen.getByRole('button', { name: 'Layout options' });
    fireEvent.click(trigger);
    expect(screen.getByRole('radiogroup', { name: 'Layout mode' })).toBeInTheDocument();
    expect(screen.getByText('Grid').closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    expect(screen.getByRole('combobox', { name: 'Grid tracks' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Horizontal gap' })).toHaveValue('64');
    expect(screen.getByRole('spinbutton', { name: 'Vertical gap' })).toHaveValue('48');
    expect(screen.getByRole('spinbutton', { name: 'Outer cluster margin' })).toHaveValue('96');
    expect(screen.getByRole('checkbox', { name: 'Pack zone contents' })).toBeChecked();
    fireEvent.click(screen.getByText('More layout options'));
    expect(screen.getByRole('checkbox', { name: 'Match zone frames' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Match heights within rows' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Match widths within columns' })).toBeChecked();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Grid tracks' }));
    fireEvent.click(screen.getByText('Columns'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Number of columns' }), {
      target: { value: '2' },
    });
    expect(screen.getByText('2×4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'grid',
        trackAxis: 'columns',
        trackCount: 2,
        density: 'preserve',
        columnGap: 64,
        rowGap: 48,
        outerMargin: 96,
      })
    );
    expect(trigger).toHaveFocus();
  });

  it('applies density and resets it to Preserve when reopened', () => {
    const onApply = vi.fn();
    render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={2} zoneOnlySelection={false} onApply={onApply} />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByText('More layout options'));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Content expansion' }));
    fireEvent.click(screen.getByText('Collapse eligible contents'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ density: 'collapse' }));

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByText('More layout options'));
    expect(screen.getByText('Preserve current expansion')).toBeInTheDocument();
  });

  it('keeps only Preserve available when density is ineligible', () => {
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
    fireEvent.click(screen.getByText('More layout options'));
    expect(screen.getByRole('combobox', { name: 'Content expansion' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ density: 'preserve' }));
  });

  it('exposes compact semantics without a second option contract', () => {
    render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={3} zoneOnlySelection onApply={vi.fn()} />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Grid tracks' })).toBeDisabled();
  });
});
