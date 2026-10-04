/**
 * Real Chromium regression for Arrange Board's portaled Ant controls.
 *
 * React synthetic pointer events from a portal still traverse SessionCanvas's
 * component ancestry. Without the canvas-layout-controls guard, the canvas
 * captures the pointer as a marquee gesture before Segmented/Checkbox/Select
 * can update, which makes the controls look inert and clears node selection.
 */
import type { AgorClient, Board, User } from '@agor-live/client';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import { CANVAS_LAYOUT_CONTROLS_CLASS } from './canvas/SelectionLayoutPopover';
import SessionCanvas from './SessionCanvas';

async function visibleSelectOption(label: string): Promise<HTMLElement> {
  let option: HTMLElement | undefined;
  await waitFor(() => {
    option = screen
      .getAllByText(label, { selector: '.ant-select-item-option-content' })
      .find(
        (candidate) =>
          !candidate
            .closest('.ant-select-dropdown')
            ?.classList.contains('ant-select-dropdown-hidden')
      );
    expect(option).toBeDefined();
  });
  return option!;
}

async function visibleMenuItem(name: RegExp): Promise<HTMLElement> {
  let menuItem: HTMLElement | undefined;
  await waitFor(
    () => {
      menuItem = screen.getAllByRole('menuitem', { hidden: true }).find(
        (candidate) =>
          name.test(candidate.textContent ?? '') &&
          candidate.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
      );
      expect(menuItem).toBeDefined();
    },
    { timeout: 10_000 }
  );
  expect(menuItem).toBeVisible();
  return menuItem!;
}

async function visibleRole(
  role: 'dialog' | 'tooltip',
  name: string | RegExp
): Promise<HTMLElement> {
  let element: HTMLElement | undefined;
  await waitFor(() => {
    element = screen
      .getAllByRole(role, { name, hidden: true })
      .find((candidate) =>
        candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      );
    expect(element).toBeDefined();
  });
  return element!;
}

// Hosted Chromium can complete the layout write and focus restoration before
// rc-motion removes the closing portal. Keep the strict visibility/teardown
// assertions, but do not mistake Testing Library's 1s DOM budget for a failure
// of the 90s real-input scenario (the Catalog browser flows use the same budget).
configure({ asyncUtilTimeout: 10_000 });
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

const translatedGeometry = (payload: Record<string, unknown>) => {
  const values = geometry(payload) as Record<
    string,
    { x: number; y: number; width: number; height: number }
  >;
  const minX = Math.min(...Object.values(values).map((value) => value.x));
  const minY = Math.min(...Object.values(values).map((value) => value.y));
  return Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      { ...value, x: value.x - minX, y: value.y - minY },
    ])
  );
};

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
    const client = {
      service: vi.fn(() => ({
        patch,
        find: vi.fn().mockResolvedValue({ capabilities: ['board.edit'] }),
      })),
    } as unknown as AgorClient;
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
    const enableAutoZone = await visibleMenuItem(/Enable Auto Zone/);
    expect(enableAutoZone.closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    await act(async () => user.click(enableAutoZone));
    expect(zoneNode).toHaveClass('selected');

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
    await act(async () => user.click(screen.getByRole('button', { name: 'More zone actions' })));
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
      durableBoard.layout_context = payload.layout_context as Board['layout_context'];
      return {
        board: durableBoard,
        placements: [],
        changed: true,
        changed_object_ids: Object.keys(payload.objects as object),
        changed_placement_ids: [],
      };
    });
    const client = {
      service: vi.fn(() => ({
        patch,
        find: vi.fn().mockResolvedValue({ capabilities: ['board.edit'] }),
      })),
    } as unknown as AgorClient;
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
    expect(dialog.getBoundingClientRect().height).toBeLessThan(420);
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(356);
    const spacingHelp = within(dialog).getByRole('button', { name: 'Spacing help' });
    // Presence precedes the portaled enter transition. Focus only after the
    // help control is actually painted at its clickable position.
    await waitFor(() => {
      expect(dialog).toBeVisible();
      const bounds = spacingHelp.getBoundingClientRect();
      expect(
        spacingHelp.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        )
      ).toBe(true);
    });
    spacingHelp.focus();
    expect(spacingHelp).toHaveFocus();
    await act(async () => user.click(within(dialog).getByText('More layout options')));
    const pack = within(dialog).getByRole('checkbox', { name: 'Pack zone contents' });
    const matchFrames = within(dialog).getByRole('checkbox', {
      name: 'Match zone frames',
    });
    const fitView = within(dialog).getByRole('checkbox', {
      name: 'Fit view after arranging',
    });
    const fitViewLabel = within(dialog).getByText('Fit view after arranging', { exact: true });
    const density = within(dialog).getByRole('combobox', { name: 'Content expansion' });
    expect(density).toBeDisabled();
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
    expect(within(dialog).getByText(/unavailable while Pack contents is off/i)).toBeVisible();
    await act(async () =>
      user.click(within(dialog).getByText('Pack zone contents', { exact: true }))
    );
    expect(pack).toBeChecked();
    await act(async () =>
      user.click(within(dialog).getByText('Match zone frames', { exact: true }))
    );
    expect(matchFrames).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Justify complete rows' })).toBeDisabled();
    await act(async () =>
      user.click(within(dialog).getByText('Match zone frames', { exact: true }))
    );
    expect(matchFrames).toBeChecked();
    const pointerJustify = within(dialog).getByRole('checkbox', { name: 'Justify complete rows' });
    await act(async () =>
      user.click(within(dialog).getByText('Justify complete rows', { exact: true }))
    );
    expect(pointerJustify).not.toBeChecked();
    await act(async () =>
      user.click(within(dialog).getByText('Justify complete rows', { exact: true }))
    );
    expect(pointerJustify).toBeChecked();
    await act(async () => user.click(within(dialog).getByText('Compact', { exact: true })));
    expect(within(dialog).getByRole('radio', { name: 'Compact' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Justify complete rows' })).toBeDisabled();
    expect(getSelectedZone()).toHaveClass('selected');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Arrange board' }));
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
    // The first opening above already proves pointer actionability for this
    // disclosure. Reopenings exercise persistence/no-op and keyboard contracts
    // without waiting on Ant's portaled motion state under a loaded CI runner.
    fireEvent.click(within(dialog).getByText('More layout options'));
    const reopenedDensity = within(dialog).getByRole('combobox', { name: 'Content expansion' });
    expect(reopenedDensity).toBeDisabled();
    expect(within(dialog).getByText('Preserve current expansion')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arrange board' }));
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
    fireEvent.click(within(dialog).getByText('More layout options'));
    const grid = within(dialog).getByRole('radio', { name: 'Grid' });
    grid.focus();
    await act(async () => user.keyboard(' '));
    expect(grid).toBeChecked();
    const justify = within(dialog).getByRole('checkbox', { name: 'Justify complete rows' });
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
      name: 'Last row: center',
    });
    expect(keyboardCenterOption.closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    await act(async () => user.keyboard('{ArrowDown}{Enter}'));
    expect(lastRow.closest('.ant-select-content')).toHaveTextContent('Last row: center');
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
  }, 90_000);

  it('uses one Grid plan for board and selection, then preserves cells for every visible action', async () => {
    if (window.innerWidth < 900) return;

    const originalObjects = {
      'zone-a': {
        type: 'zone' as const,
        x: 80,
        y: 80,
        width: 650,
        height: 260,
        label: 'Fictional Alpha',
      },
      'zone-b': {
        type: 'zone' as const,
        x: 720,
        y: 120,
        width: 780,
        height: 340,
        label: 'Fictional Beta',
      },
      'zone-c': {
        type: 'zone' as const,
        x: 100,
        y: 620,
        width: 700,
        height: 300,
        label: 'Fictional Gamma',
      },
      'zone-d': {
        type: 'zone' as const,
        x: 760,
        y: 680,
        width: 900,
        height: 420,
        label: 'Fictional Delta',
      },
      'zone-e': {
        type: 'zone' as const,
        x: 1440,
        y: 80,
        width: 740,
        height: 320,
        label: 'Fictional Epsilon',
      },
      obstacle: {
        type: 'zone' as const,
        x: 580,
        y: 470,
        width: 280,
        height: 180,
        label: 'Fictional Locked Obstacle',
        locked: true,
      },
    };

    const renderProductionCanvas = (durableBoard: Board, patch: ReturnType<typeof vi.fn>) => {
      const client = {
        service: vi.fn(() => ({
          patch,
          find: vi.fn().mockResolvedValue({ capabilities: ['board.edit'] }),
        })),
      } as unknown as AgorClient;
      return render(
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
    };

    const makeBoardAndPatch = () => {
      const durableBoard = {
        board_id: 'fictional-production-layout-board',
        objects: structuredClone(originalObjects),
      } as unknown as Board;
      const writes: Record<string, unknown>[] = [];
      const patch = vi.fn(async (_boardId: string, payload: Record<string, unknown>) => {
        writes.push(payload);
        for (const [id, update] of Object.entries(
          payload.objects as NonNullable<Board['objects']>
        )) {
          Object.assign(durableBoard.objects?.[id] ?? {}, update);
        }
        durableBoard.layout_context = payload.layout_context as Board['layout_context'];
        return {
          board: durableBoard,
          placements: [],
          changed: true,
          changed_object_ids: Object.keys(payload.objects as object),
          changed_placement_ids: [],
        };
      });
      return { durableBoard, patch, writes };
    };

    const configureVisibleGrid = async (surface: HTMLElement) => {
      const user = userEvent.setup();
      const grid = within(surface).getByRole('radio', { name: 'Grid' });
      if (!grid.hasAttribute('checked')) await act(async () => user.click(grid));
      const tracks = within(surface).getByText('Auto tracks', { exact: true });
      fireEvent.mouseDown(tracks);
      fireEvent.click(await visibleSelectOption('Columns'));
      const count = within(surface).getByRole('spinbutton', { name: 'Number of columns' });
      fireEvent.change(count, { target: { value: '2' } });
      expect(within(surface).getByRole('spinbutton', { name: 'Horizontal gap' })).toHaveValue('64');
      expect(within(surface).getByRole('spinbutton', { name: 'Vertical gap' })).toHaveValue('48');
      await act(async () => user.click(within(surface).getByText('More layout options')));
      const matchRows = within(surface).getByRole('switch', {
        name: 'Match heights within rows',
      });
      await waitFor(() => expect(matchRows).toBeVisible());
      // Ant's Collapse mounts its children before the height motion settles.
      // Waiting for that real portal motion prevents a click intended for the
      // first control from landing on the disclosure header instead.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await act(async () => user.click(matchRows));
      await act(async () =>
        user.click(within(surface).getByRole('switch', { name: 'Match widths within columns' }))
      );
      await act(async () =>
        user.click(within(surface).getByRole('checkbox', { name: 'Match zone frames' }))
      );
    };

    // A. Arrange Board toolbar -> Grid -> Apply.
    const boardRun = makeBoardAndPatch();
    renderProductionCanvas(boardRun.durableBoard, boardRun.patch);
    const user = userEvent.setup();
    await act(async () => user.click(screen.getByRole('button', { name: 'Arrange board' })));
    const boardDialog = await visibleRole('dialog', 'Arrange board options');
    await configureVisibleGrid(boardDialog);
    await act(async () =>
      user.click(within(boardDialog).getByRole('checkbox', { name: 'Fit view after arranging' }))
    );
    await act(async () =>
      user.click(within(boardDialog).getByRole('button', { name: 'Arrange board' }))
    );
    await waitFor(() => expect(boardRun.patch).toHaveBeenCalledTimes(1));
    const boardPayload = boardRun.writes[0]!;
    await waitFor(() =>
      expect(
        document.querySelector('[role="dialog"][aria-label="Arrange board options"]')
      ).toBeNull()
    );
    const boardArrangeTrigger = document.querySelector<HTMLButtonElement>(
      'button.react-flow__controls-button[aria-label="Arrange board"]'
    );
    if (!boardArrangeTrigger) throw new Error('Arrange board toolbar trigger is unavailable.');
    await waitFor(() => expect(boardArrangeTrigger).toHaveAttribute('aria-disabled', 'false'), {
      timeout: 5_000,
    });
    await act(async () => user.click(boardArrangeTrigger));
    const boardCompactDialog = await visibleRole('dialog', 'Arrange board options');
    await act(async () =>
      user.click(within(boardCompactDialog).getByText('Compact', { exact: true }))
    );
    await act(async () =>
      user.click(within(boardCompactDialog).getByRole('button', { name: 'Arrange board' }))
    );
    await waitFor(() => expect(boardRun.patch).toHaveBeenCalledTimes(2));
    const boardCompactPayload = boardRun.writes[1]!;
    cleanup();

    // B/C. Select the exact same eligible zones, use Layout selected items,
    // then click the distinct zone-only Tidy action as a no-op repeat.
    const selectionRun = makeBoardAndPatch();
    renderProductionCanvas(selectionRun.durableBoard, selectionRun.patch);
    const selectionUser = userEvent.setup();
    const selectionNodes: HTMLElement[] = [];
    for (const id of ['zone-a', 'zone-b', 'zone-c', 'zone-d', 'zone-e']) {
      const node = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
        if (!element) throw new Error(`Missing fictional node ${id}`);
        return element;
      });
      selectionNodes.push(node);
    }
    await act(async () => selectionUser.click(selectionNodes[0]!));
    await waitFor(() => expect(selectionNodes[0]).toHaveClass('selected'));
    await act(async () => selectionUser.keyboard('{Shift>}'));
    for (const node of selectionNodes.slice(1)) {
      await act(async () => selectionUser.click(node));
    }
    await act(async () => selectionUser.keyboard('{/Shift}'));
    const toolbar = await screen.findByRole('toolbar', { name: 'Arrange selected items' });
    expect(within(toolbar).getByRole('button', { name: 'Arrange zones' })).toBeVisible();
    await act(async () =>
      selectionUser.click(within(toolbar).getByRole('button', { name: 'Layout options' }))
    );
    const selectionSurface = await visibleRole('tooltip', /Layout selected items/);
    expect(selectionSurface.getBoundingClientRect().height).toBeLessThan(390);
    await configureVisibleGrid(selectionSurface);
    await act(async () =>
      selectionUser.click(within(selectionSurface).getByRole('button', { name: 'Apply layout' }))
    );
    await waitFor(() => expect(selectionRun.patch).toHaveBeenCalledTimes(1));
    const selectionPayload = selectionRun.writes[0]!;

    expect((selectionPayload.layout_context as Board['layout_context'])?.settings).toEqual(
      (boardPayload.layout_context as Board['layout_context'])?.settings
    );
    expect(translatedGeometry(selectionPayload)).toEqual(translatedGeometry(boardPayload));

    // Both production editors feed Compact through the same settings and
    // planner as well. Compare after the same Grid source state so only the
    // intentional board-vs-selection anchor can differ.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Layout options' }));
    const firstCompactSurface = await visibleRole('tooltip', /Layout selected items/);
    fireEvent.click(within(firstCompactSurface).getByText('Compact', { exact: true }));
    fireEvent.click(within(firstCompactSurface).getByRole('button', { name: 'Apply layout' }));
    await waitFor(() => expect(selectionRun.patch).toHaveBeenCalledTimes(2));
    const selectionCompactPayload = selectionRun.writes[1]!;
    expect((selectionCompactPayload.layout_context as Board['layout_context'])?.settings).toEqual(
      (boardCompactPayload.layout_context as Board['layout_context'])?.settings
    );
    expect(translatedGeometry(selectionCompactPayload)).toEqual(
      translatedGeometry(boardCompactPayload)
    );

    // Return to the exact prior Grid configuration before exercising its
    // cell-specific alignment and match-size actions.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Layout options' }));
    const restoredGridSurface = await visibleRole('tooltip', /Layout selected items/);
    fireEvent.click(within(restoredGridSurface).getByText('Grid', { exact: true }));
    fireEvent.click(within(restoredGridSurface).getByRole('button', { name: 'Apply layout' }));
    await waitFor(() => expect(selectionRun.patch).toHaveBeenCalledTimes(3));

    const initialCells = selectionRun.durableBoard.layout_context?.cells;
    expect(new Set(Object.values(initialCells ?? {}).map((cell) => cell.column)).size).toBe(2);
    expect(new Set(Object.values(initialCells ?? {}).map((cell) => cell.row)).size).toBe(3);
    const membership = Object.fromEntries(
      Object.entries(initialCells ?? {}).map(([id, cell]) => [id, [cell.row, cell.column]])
    );

    const beforeArrangeZones = selectionRun.patch.mock.calls.length;
    const arrangeZonesButton = within(toolbar).getByRole('button', { name: 'Arrange zones' });
    arrangeZonesButton.focus();
    await act(async () => selectionUser.keyboard('{Enter}'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(selectionRun.patch).toHaveBeenCalledTimes(beforeArrangeZones);

    // D. All six actual alignment actions remain Grid-cell actions. Start/top
    // can be changed-only no-ops; every other action must still retain tracks.
    for (const action of [
      /Left \/ start/,
      /Horizontal center/,
      /Right \/ end/,
      /Top \/ start/,
      /Vertical center/,
      /Bottom \/ end/,
    ]) {
      fireEvent.click(within(toolbar).getByRole('button', { name: 'More alignment actions' }));
      fireEvent.click(await visibleMenuItem(action));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const cells = selectionRun.durableBoard.layout_context?.cells ?? {};
      expect(
        Object.fromEntries(Object.entries(cells).map(([id, cell]) => [id, [cell.row, cell.column]]))
      ).toEqual(membership);
      expect(new Set(Object.values(cells).map((cell) => cell.column)).size).toBe(2);
      expect(new Set(Object.values(cells).map((cell) => cell.row)).size).toBe(3);
    }
    expect(selectionRun.durableBoard.layout_context?.settings).toMatchObject({
      cellHorizontalAlignment: 'end',
      cellVerticalAlignment: 'end',
    });

    // E. Match uses the maximum safe axis and performs its reflow in the same
    // applyLayout payload; the repeat is a zero-write no-op.
    const expectedWidth = Math.max(
      ...Object.values(selectionRun.durableBoard.layout_context?.cells ?? {}).map(
        (cell) => cell.width
      )
    );
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Match width' }));
    await waitFor(() => {
      const widths = Object.values(selectionRun.durableBoard.layout_context?.cells ?? {}).map(
        (cell) => cell.width
      );
      expect(new Set(widths)).toEqual(new Set([expectedWidth]));
    });
    const afterWidthWrites = selectionRun.patch.mock.calls.length;
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Match width' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(selectionRun.patch).toHaveBeenCalledTimes(afterWidthWrites);

    const expectedHeight = Math.max(
      ...Object.values(selectionRun.durableBoard.layout_context?.cells ?? {}).map(
        (cell) => cell.height
      )
    );
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Match height' }));
    await waitFor(() => {
      const heights = Object.values(selectionRun.durableBoard.layout_context?.cells ?? {}).map(
        (cell) => cell.height
      );
      expect(new Set(heights)).toEqual(new Set([expectedHeight]));
    });
    expect(
      Object.fromEntries(
        Object.entries(selectionRun.durableBoard.layout_context?.cells ?? {}).map(([id, cell]) => [
          id,
          [cell.row, cell.column],
        ])
      )
    ).toEqual(membership);

    // The same selected-items surface also switches to Compact. Subsequent
    // alignment remains a dense two-dimensional Compact replan rather than a
    // generic same-x/same-y collapse.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Layout options' }));
    const compactSurface = await visibleRole('tooltip', /Layout selected items/);
    fireEvent.click(within(compactSurface).getByText('Compact', { exact: true }));
    fireEvent.click(within(compactSurface).getByRole('button', { name: 'Apply layout' }));
    await waitFor(() =>
      expect(selectionRun.durableBoard.layout_context?.settings.mode).toBe('compact')
    );
    const assertCompactCluster = () => {
      const cells = Object.values(selectionRun.durableBoard.layout_context?.cells ?? {});
      expect(new Set(cells.map((cell) => cell.x)).size).toBeGreaterThan(1);
      expect(new Set(cells.map((cell) => cell.y)).size).toBeGreaterThan(1);
      expect(selectionRun.durableBoard.layout_context?.settings.mode).toBe('compact');
    };
    assertCompactCluster();
    for (const action of [/Right \/ end/, /Bottom \/ end/]) {
      fireEvent.click(within(toolbar).getByRole('button', { name: 'More alignment actions' }));
      fireEvent.click(await visibleMenuItem(action));
      await new Promise((resolve) => setTimeout(resolve, 120));
      assertCompactCluster();
    }
  }, 90_000);
});
