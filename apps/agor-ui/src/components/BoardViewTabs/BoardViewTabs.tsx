import type { BoardView } from '@agor-live/client';
import { CheckCircleFilled, HolderOutlined } from '@ant-design/icons';
import { Dropdown, Flex, Tabs, type TabsProps, Tooltip, theme } from 'antd';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { VISUALLY_HIDDEN_STYLE } from '../../utils/accessibility';
import {
  availableBoardViews,
  BOARD_VIEW_ICONS,
  BOARD_VIEW_LABELS,
  boardViewMoveForKey,
  moveBoardView,
} from '../../utils/boardViews';
import type { SortableTabBarProps } from './SortableTabBar';

const SortableTabBar = lazy(() => import('./SortableTabBar'));

export const BOARD_VIEW_TABS_HEIGHT = 36;
const DRAG_HINT = 'The first tab is where this board opens for everyone.';
const AFTER_MOVE_TIP_MS = 6000;
const opensOnText = (view: BoardView) =>
  `This board now opens on ${BOARD_VIEW_LABELS[view]} for everyone.`;

interface BoardViewTabsProps {
  /** The board's full tab order; only the shown views are drawn. */
  order: BoardView[];
  view: BoardView;
  onPick: (view: BoardView) => void;
  /** Editors only. Viewers get plain tabs: no grip, tooltip, menu or drag. */
  onReorder?: (order: BoardView[]) => void;
}

/** An editor's tab label: the hover grip, and the hint, drag or after-move tooltip. */
const EditableTabLabel: React.FC<{
  view: BoardView;
  showGrip: boolean;
  /** Some tab is being dragged; this one when `dragged`. */
  dragging: boolean;
  dragged: boolean;
  /** Says where the board now opens, after this tab became the first one. */
  showFirstTabTip: boolean;
}> = ({ view, showGrip, dragging, dragged, showFirstTabTip }) => {
  const { token } = theme.useToken();
  const label = (
    <span>
      {BOARD_VIEW_LABELS[view]}
      <HolderOutlined
        aria-hidden
        style={{
          fontSize: 12,
          color: token.colorTextQuaternary,
          marginInlineStart: token.marginXXS,
          visibility: showGrip ? 'visible' : 'hidden',
        }}
      />
    </span>
  );
  if (showFirstTabTip || dragged) {
    return (
      <Tooltip
        open
        placement={dragged ? 'bottom' : 'bottomLeft'}
        title={
          dragged ? (
            DRAG_HINT
          ) : (
            <Flex align="center" gap={token.marginXS}>
              <CheckCircleFilled style={{ color: token.colorSuccess }} />
              <span>{opensOnText(view)}</span>
            </Flex>
          )
        }
      >
        {label}
      </Tooltip>
    );
  }
  return (
    <Tooltip
      title={dragging ? undefined : 'Drag to reorder. Alt + arrow keys also move it.'}
      mouseEnterDelay={0.5}
    >
      {label}
    </Tooltip>
  );
};

export const BoardViewTabs: React.FC<BoardViewTabsProps> = ({ order, view, onPick, onReorder }) => {
  const { token } = theme.useToken();
  const rowRef = useRef<HTMLDivElement>(null);
  const shown = availableBoardViews(order);
  const [hovered, setHovered] = useState<BoardView | null>(null);
  const [dragging, setDragging] = useState<BoardView | null>(null);
  const [firstTabTip, setFirstTabTip] = useState<BoardView | null>(null);

  useEffect(() => {
    if (!firstTabTip) return;
    const timer = window.setTimeout(() => setFirstTabTip(null), AFTER_MOVE_TIP_MS);
    return () => window.clearTimeout(timer);
  }, [firstTabTip]);

  const focusTab = (key: BoardView) =>
    rowRef.current?.querySelector<HTMLElement>(`[data-node-key="${key}"] [role="tab"]`)?.focus();

  const move = (moved: BoardView, delta: number) => {
    if (!onReorder) return;
    const next = moveBoardView(order, moved, delta);
    const nextFirst = availableBoardViews(next)[0];
    onReorder(next);
    setFirstTabTip(nextFirst !== shown[0] ? nextFirst : null);
    // Keyed nodes move in the DOM, which can drop focus; keep it on the moved tab.
    requestAnimationFrame(() => focusTab(moved));
  };

  // The pointer is released over the dragged tab; that click is not a pick.
  const justDraggedRef = useRef(false);
  const handleDragEnd = (moved: BoardView, over: BoardView | null) => {
    setDragging(null);
    justDraggedRef.current = true;
    window.setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
    if (over && over !== moved) move(moved, shown.indexOf(over) - shown.indexOf(moved));
  };

  // The whole tab node carries the Move menu, so the keyboard's context-menu key
  // on the focused tab opens it too. Alt + arrows run in the capture phase: before
  // rc-tabs' arrow navigation, and stopping the browser's Alt + Left "back".
  const wrapNode: SortableTabBarProps['wrapNode'] = (node) => {
    const key = node.key as BoardView;
    const index = shown.indexOf(key);
    return (
      <Dropdown
        key={key}
        trigger={['contextMenu']}
        // Focus the menu so the keyboard can use it, opened by the context-menu key.
        // Closing it returns focus to the tab, unless the person clicked elsewhere.
        autoFocus
        onOpenChange={(open) => {
          const active = document.activeElement;
          if (!open && (!active || active === document.body || active.closest('.ant-dropdown'))) {
            focusTab(key);
          }
        }}
        menu={{
          items: [
            { key: 'left', label: 'Move left', disabled: index <= 0, onClick: () => move(key, -1) },
            {
              key: 'right',
              label: 'Move right',
              disabled: index >= shown.length - 1,
              onClick: () => move(key, 1),
            },
          ],
        }}
      >
        {React.cloneElement(node as React.ReactElement<React.HTMLAttributes<HTMLElement>>, {
          onMouseEnter: () => setHovered(key),
          onMouseLeave: () => setHovered(null),
          onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => {
            const delta = boardViewMoveForKey(event);
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            move(key, delta);
          },
        })}
      </Dropdown>
    );
  };

  const items: TabsProps['items'] = shown.map((key) => ({
    key,
    icon: BOARD_VIEW_ICONS[key],
    label: onReorder ? (
      <EditableTabLabel
        view={key}
        showGrip={hovered === key && !dragging}
        dragging={!!dragging}
        dragged={dragging === key}
        showFirstTabTip={firstTabTip === key}
      />
    ) : (
      BOARD_VIEW_LABELS[key]
    ),
  }));

  // Editors get the menu and keys at once; drag arrives with the lazily loaded bar.
  const renderTabBar: TabsProps['renderTabBar'] = onReorder
    ? (tabBarProps, DefaultTabBar) => (
        <Suspense fallback={<DefaultTabBar {...tabBarProps}>{wrapNode}</DefaultTabBar>}>
          <SortableTabBar
            tabBarProps={tabBarProps}
            DefaultTabBar={DefaultTabBar}
            views={shown}
            wrapNode={wrapNode}
            regionRef={rowRef}
            onDragStart={(dragged) => {
              setDragging(dragged);
              setFirstTabTip(null);
            }}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDragging(null)}
          />
        </Suspense>
      )
    : undefined;

  return (
    <div
      ref={rowRef}
      style={{
        flexShrink: 0,
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Tabs
        size="small"
        activeKey={view}
        onChange={(key) => {
          if (!justDraggedRef.current) onPick(key as BoardView);
        }}
        items={items}
        renderTabBar={renderTabBar}
        tabBarStyle={{ height: BOARD_VIEW_TABS_HEIGHT, margin: 0, paddingInline: token.paddingSM }}
      />
      {/* The after-move tooltip is not announced; this says the same for screen readers. */}
      <span role="status" aria-live="polite" style={VISUALLY_HIDDEN_STYLE}>
        {firstTabTip ? opensOnText(firstTabTip) : ''}
      </span>
    </div>
  );
};
