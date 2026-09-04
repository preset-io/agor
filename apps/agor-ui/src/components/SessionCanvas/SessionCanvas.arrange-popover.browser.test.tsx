/**
 * Real Chromium regression for Arrange Board's portaled Ant controls.
 *
 * React synthetic pointer events from a portal still traverse SessionCanvas's
 * component ancestry. Without the canvas-layout-controls guard, the canvas
 * captures the pointer as a marquee gesture before Segmented/Checkbox/Select
 * can update, which makes the controls look inert and clears node selection.
 */
import type { AgorClient, Board, User } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import { CANVAS_LAYOUT_CONTROLS_CLASS } from './canvas/SelectionLayoutPopover';
import SessionCanvas from './SessionCanvas';

afterEach(cleanup);

const CURRENT_USER = {
  user_id: 'fictional-layout-owner',
  username: 'fictional-layout-owner',
  role: 'member',
} as User;

beforeEach(() => {
  __setAuthConfigForTests({ requireAuth: false }, { branchRbac: false });
  agorStore.setState({ userById: new Map([[CURRENT_USER.user_id, CURRENT_USER]]) });
});

const geometry = (payload: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(
      payload.objects as Record<string, { x: number; y: number; width: number; height: number }>
    )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => [
        id,
        { x: value.x, y: value.y, width: value.width, height: value.height },
      ])
  );

describe('SessionCanvas Arrange Board popover (real browser)', () => {
  it('keeps legacy text and toolbar state changes free of product-owned style warnings', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const manualBoard = {
      board_id: 'fictional-console-board',
      objects: {
        'legacy-text': {
          type: 'text',
          x: 20,
          y: 40,
          content: 'Fictional legacy annotation',
        },
        zone: {
          type: 'zone',
          x: 100,
          y: 120,
          width: 500,
          height: 400,
          label: 'Fictional review',
          layout: { mode: 'manual' },
        },
      },
    } as unknown as Board;
    const patch = vi.fn();
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const renderCanvas = (board: Board) => (
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas
            board={board}
            client={client}
            branches={[]}
            currentUserId={CURRENT_USER.user_id}
            height={700}
          />
        </ConnectionProvider>
      </AntApp>
    );

    const view = render(renderCanvas(manualBoard));
    const user = userEvent.setup();
    const zoneNode = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.react-flow__node[data-id="zone"]');
      if (!node) throw new Error('Fictional zone did not render.');
      return node;
    });
    await act(async () => user.click(zoneNode));
    const toolbar = screen.getByRole('toolbar', { name: 'Zone actions' });
    expect(Number.isFinite(Number.parseFloat(toolbar.style.left))).toBe(true);
    expect(document.querySelector('.react-flow__node[data-id="legacy-text"]')).toBeNull();
    await act(async () => user.click(screen.getByRole('button', { name: 'More zone actions' })));
    expect(await screen.findByText('Enable Auto Zone')).toBeInTheDocument();

    view.rerender(
      renderCanvas({
        ...manualBoard,
        objects: {
          ...manualBoard.objects,
          zone: {
            ...manualBoard.objects?.zone,
            type: 'zone',
            layout: { mode: 'auto' },
          },
        },
      } as Board)
    );
    expect(await screen.findByText('Disable Auto Zone')).toBeInTheDocument();

    const productStyleWarnings = consoleError.mock.calls.filter((args) => {
      const message = args.map(String).join(' ');
      return (
        /NaN is an invalid value for the [`']?left/i.test(message) ||
        (/borderColor/i.test(message) && /shorthand|rerender|style property/i.test(message))
      );
    });
    expect(productStyleWarnings).toEqual([]);
    consoleError.mockRestore();
  });

  it('keeps pointer and keyboard input inside the portal and applies the selected planner options', async () => {
    // This interaction regression needs enough space for React Flow's desktop
    // controls and the complete option surface. Narrow projects still import
    // the test; responsive toolbar placement is covered separately.
    if (window.innerWidth < 900) return;

    const objects = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [
        `zone-${index}`,
        {
          type: 'zone' as const,
          x: (index % 3) * 760 + (index % 2) * 80,
          y: Math.floor(index / 3) * 620 + (index % 3) * 60,
          width: index % 2 === 0 ? 420 : 680,
          height: index % 3 === 0 ? 760 : 320,
          label: `Fictional ${index}`,
        },
      ])
    );
    const durableBoard = {
      board_id: 'fictional-arrange-popover-board',
      objects,
    } as unknown as Board;
    const patch = vi.fn(async (_boardId: string, payload: Record<string, unknown>) => {
      for (const [id, update] of Object.entries(payload.objects as NonNullable<Board['objects']>)) {
        Object.assign(durableBoard.objects?.[id] ?? {}, update);
      }
      return {
        board: durableBoard,
        placements: [],
        changed: true,
        changed_object_ids: Object.keys(payload.objects as object),
        changed_placement_ids: [],
      };
    });
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    render(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas
            board={durableBoard}
            client={client}
            branches={[]}
            currentUserId={CURRENT_USER.user_id}
            height={760}
          />
        </ConnectionProvider>
      </AntApp>
    );

    const user = userEvent.setup();
    const getTrigger = () => {
      const button = document.querySelector<HTMLButtonElement>(
        'button.react-flow__controls-button[aria-label="Arrange board"]'
      );
      if (!button) throw new Error('Arrange board toolbar trigger is unavailable.');
      return button;
    };
    let trigger = await screen.findByRole('button', { name: 'Arrange board' });
    const getSelectedZone = () =>
      document.querySelector<HTMLElement>('.react-flow__node[data-id="zone-0"]');
    const selectedZone = getSelectedZone();
    expect(selectedZone).toBeTruthy();
    await act(async () => user.click(selectedZone!));
    await waitFor(() => expect(selectedZone).toHaveClass('selected'));

    // Pointer activation must reach the actual visible labels inside the
    // portaled surface, not only hidden checkbox/radio inputs used by jsdom.
    await act(async () => user.click(trigger));
    let dialog = await screen.findByRole('dialog', { name: 'Arrange board options' });
    expect(dialog.closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    const pack = within(dialog).getByRole('checkbox', { name: 'Pack zone contents' });
    const matchFrames = within(dialog).getByRole('checkbox', {
      name: 'Match / resize zone frames',
    });
    const fitView = within(dialog).getByRole('checkbox', {
      name: 'Fit view after arranging',
    });
    const fitViewLabel = within(dialog).getByText('Fit view after arranging', { exact: true });
    const density = within(dialog).getByRole('combobox', { name: 'Content expansion' });
    await act(async () => user.click(density));
    let collapse: HTMLElement | undefined;
    await waitFor(() => {
      collapse = screen
        .getAllByText('Collapse eligible contents', {
          selector: '.ant-select-item-option-content',
        })
        .find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        });
      expect(collapse).toBeVisible();
    });
    expect(collapse.closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    await act(async () => user.click(collapse!));
    await waitFor(() => expect(density).toHaveAttribute('aria-expanded', 'false'));
    expect(fitView).toBeChecked();
    await waitFor(() => expect(fitViewLabel).toBeVisible());
    await act(async () => user.click(fitViewLabel));
    expect(fitView).not.toBeChecked();
    await act(async () => user.click(fitViewLabel));
    expect(fitView).toBeChecked();
    await act(async () =>
      user.click(within(dialog).getByText('Pack zone contents', { exact: true }))
    );
    expect(pack).not.toBeChecked();
    expect(density).toBeDisabled();
    expect(matchFrames).toBeDisabled();
    expect(within(dialog).getByText(/existing zone frames are preserved/i)).toBeVisible();
    await act(async () =>
      user.click(within(dialog).getByText('Pack zone contents', { exact: true }))
    );
    expect(pack).toBeChecked();
    await act(async () =>
      user.click(within(dialog).getByText('Match / resize zone frames', { exact: true }))
    );
    expect(matchFrames).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Justify rows' })).toBeDisabled();
    await act(async () =>
      user.click(within(dialog).getByText('Match / resize zone frames', { exact: true }))
    );
    expect(matchFrames).toBeChecked();
    const pointerJustify = within(dialog).getByRole('checkbox', { name: 'Justify rows' });
    await act(async () => user.click(within(dialog).getByText('Justify rows', { exact: true })));
    expect(pointerJustify).not.toBeChecked();
    await act(async () => user.click(within(dialog).getByText('Justify rows', { exact: true })));
    expect(pointerJustify).toBeChecked();
    await act(async () => user.click(within(dialog).getByText('Compact', { exact: true })));
    expect(within(dialog).getByRole('radio', { name: 'Compact' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Justify rows' })).toBeDisabled();
    expect(
      within(dialog).getByText(
        'Unavailable in Compact, which minimizes cluster diameter instead of forming rows.'
      )
    ).toBeVisible();
    expect(getSelectedZone()).toHaveClass('selected');

    await act(async () =>
      user.click(within(dialog).getByRole('button', { name: 'Arrange board' }))
    );
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getTrigger()).toHaveFocus());
    trigger = getTrigger();
    await waitFor(() =>
      expect(
        document.querySelector('[role="dialog"][aria-label="Arrange board options"]')
      ).toBeNull()
    );
    const compactGeometry = geometry(patch.mock.calls[0]![1] as Record<string, unknown>);

    // The exact same action is a changed-only no-op: no second mutation and
    // no focus loss after the popover closes.
    await waitFor(() => expect(getTrigger()).toHaveAttribute('aria-disabled', 'false'), {
      timeout: 3_000,
    });
    await act(async () => user.click(trigger));
    dialog = await screen.findByRole('dialog', { name: 'Arrange board options' });
    const reopenedDensity = within(dialog).getByRole('combobox', { name: 'Content expansion' });
    await act(async () => user.click(reopenedDensity));
    let preserve: HTMLElement | undefined;
    await waitFor(() => {
      preserve = screen
        .getAllByText('Preserve current expansion', {
          selector: '.ant-select-item-option-content',
        })
        .find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        });
      expect(preserve).toBeVisible();
    });
    expect(preserve!.closest('.ant-select-item-option')).toHaveClass(
      'ant-select-item-option-selected'
    );
    await act(async () =>
      user.click(within(dialog).getByRole('button', { name: 'Arrange board' }))
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(getTrigger()).toHaveFocus();
    await waitFor(() =>
      expect(
        document.querySelector('[role="dialog"][aria-label="Arrange board options"]')
      ).toBeNull()
    );

    // Keyboard selection exercises the same portaled controls and then proves
    // that state reaches the authoritative planner rather than only changing
    // Ant's visual selection.
    trigger = getTrigger();
    await act(async () => user.click(trigger));
    dialog = await screen.findByRole('dialog', { name: 'Arrange board options' });
    const grid = within(dialog).getByRole('radio', { name: 'Grid' });
    grid.focus();
    await act(async () => user.keyboard(' '));
    expect(grid).toBeChecked();
    const justify = within(dialog).getByRole('checkbox', { name: 'Justify rows' });
    justify.focus();
    await act(async () => user.keyboard(' '));
    expect(justify).not.toBeChecked();
    const keyboardFitView = within(dialog).getByRole('checkbox', {
      name: 'Fit view after arranging',
    });
    keyboardFitView.focus();
    await act(async () => user.keyboard(' '));
    expect(keyboardFitView).not.toBeChecked();
    const lastRow = within(dialog).getByRole('combobox', { name: 'Last row behavior' });
    lastRow.focus();
    await act(async () => user.keyboard('{Enter}'));
    const keyboardCenterOption = await screen.findByRole('option', {
      name: 'Last row: centered',
    });
    expect(keyboardCenterOption.closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    await act(async () => user.keyboard('{ArrowDown}{Enter}'));
    expect(lastRow.closest('.ant-select-content')).toHaveTextContent('Last row: centered');
    const applyNaturalGrid = within(dialog).getByRole('button', { name: 'Arrange board' });
    applyNaturalGrid.focus();
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getTrigger()).toHaveFocus());
    trigger = getTrigger();
    await waitFor(() =>
      expect(
        document.querySelector('[role="dialog"][aria-label="Arrange board options"]')
      ).toBeNull()
    );
    const naturalGridGeometry = geometry(patch.mock.calls[1]![1] as Record<string, unknown>);
    expect(naturalGridGeometry).not.toEqual(compactGeometry);
    expect(getSelectedZone()).toHaveClass('selected');

    expect(patch).toHaveBeenCalledTimes(2);
  });
});
