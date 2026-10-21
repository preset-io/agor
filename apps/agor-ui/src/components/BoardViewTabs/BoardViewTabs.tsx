import type { BoardView } from '@agor-live/client';
import { CheckCircleFilled, HolderOutlined } from '@ant-design/icons';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Dropdown, Flex, Tabs, type TabsProps, Tooltip, theme } from 'antd';
import React, { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import {
  availableBoardViews,
  BOARD_VIEW_ICONS,
  BOARD_VIEW_LABELS,
  boardViewMoveForKey,
  moveBoardView,
} from '../../utils/boardViews';

export const BOARD_VIEW_TABS_HEIGHT = 36;
const DRAG_HINT = 'The first tab is where this board opens for everyone.';
const AFTER_MOVE_TIP_MS = 6000;

interface BoardViewTabsProps {
  /** The board's full tab order; only the shown views are drawn. */
  order: BoardView[];
  view: BoardView;
  onPick: (view: BoardView) => void;
  /** Editors only. Viewers get plain tabs: no grip, tooltip, menu or drag. */
  onReorder?: (order: BoardView[]) => void;
}

type TabNodeProps = React.HTMLAttributes<HTMLDivElement> & {
  'data-node-key': string;
  children: React.ReactElement<React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<unknown> }>;
  dragging: boolean;
  onMoveKey: (view: BoardView, delta: -1 | 1) => void;
};

/** One rc-tabs tab node made sortable, as in antd's draggable tabs demo. */
const SortableTabNode: React.FC<TabNodeProps> = ({
  dragging,
  onMoveKey,
  onMouseEnter,
  onMouseLeave,
  children,
  'data-node-key': nodeKey,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const view = nodeKey as BoardView;
  const { listeners, setNodeRef, transform, transition } = useSortable({
    id: view,
    transition: reducedMotion ? null : undefined,
  });
  const node = React.cloneElement(children, {
    ref: setNodeRef,
    style: {
      ...children.props.style,
      transform: CSS.Translate.toString(transform),
      transition: reducedMotion ? undefined : transition,
      cursor: dragging ? 'grabbing' : 'grab',
    },
    ...listeners,
    onMouseEnter,
    onMouseLeave,
    // Capture phase: runs before rc-tabs' arrow navigation, and stops the browser's Alt + Left "back".
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = boardViewMoveForKey(event);
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      onMoveKey(view, delta);
    },
  });
  return dragging ? (
    <Tooltip open title={DRAG_HINT} placement="bottom">
      {node}
    </Tooltip>
  ) : (
    node
  );
};

/** An editor's tab label: tooltip, hover grip and the Move left / Move right menu. */
const EditableTabLabel: React.FC<{
  label: string;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  showGrip: boolean;
  dragging: boolean;
  /** Says where the board now opens, after this tab became the first one. */
  showFirstTabTip: boolean;
  onMove: (delta: -1 | 1) => void;
}> = ({ label, canMoveLeft, canMoveRight, showGrip, dragging, showFirstTabTip, onMove }) => {
  const { token } = theme.useToken();
  const content = (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: [
          { key: 'left', label: 'Move left', disabled: !canMoveLeft, onClick: () => onMove(-1) },
          { key: 'right', label: 'Move right', disabled: !canMoveRight, onClick: () => onMove(1) },
        ],
      }}
    >
      <span>
        {label}
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
    </Dropdown>
  );
  if (showFirstTabTip) {
    return (
      <Tooltip
        open
        placement="bottomLeft"
        title={
          <Flex align="center" gap={token.marginXS}>
            <CheckCircleFilled style={{ color: token.colorSuccess }} />
            <span>This board now opens on {label} for everyone.</span>
          </Flex>
        }
      >
        {content}
      </Tooltip>
    );
  }
  return (
    <Tooltip
      title={dragging ? undefined : 'Drag to reorder. Alt + arrow keys also move it.'}
      mouseEnterDelay={0.5}
    >
      {content}
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    if (!firstTabTip) return;
    const timer = window.setTimeout(() => setFirstTabTip(null), AFTER_MOVE_TIP_MS);
    return () => window.clearTimeout(timer);
  }, [firstTabTip]);

  const reorder = (next: BoardView[], moved: BoardView) => {
    if (!onReorder) return;
    const nextFirst = availableBoardViews(next)[0];
    onReorder(next);
    setFirstTabTip(nextFirst !== shown[0] ? nextFirst : null);
    // Keyed nodes move in the DOM, which can drop focus; keep it on the moved tab.
    requestAnimationFrame(() =>
      rowRef.current?.querySelector<HTMLElement>(`[data-node-key="${moved}"] [role="tab"]`)?.focus()
    );
  };
  const move = (moved: BoardView, delta: number) =>
    reorder(moveBoardView(order, moved, delta), moved);

  // The pointer is released over the dragged tab; that click is not a pick.
  const justDraggedRef = useRef(false);
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    justDraggedRef.current = true;
    window.setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
    if (!over || active.id === over.id) return;
    const moved = active.id as BoardView;
    move(moved, shown.indexOf(over.id as BoardView) - shown.indexOf(moved));
  };

  const items: TabsProps['items'] = shown.map((key, index) => {
    const label = BOARD_VIEW_LABELS[key];
    if (!onReorder) return { key, icon: BOARD_VIEW_ICONS[key], label };
    return {
      key,
      icon: BOARD_VIEW_ICONS[key],
      label: (
        <EditableTabLabel
          label={label}
          canMoveLeft={index > 0}
          canMoveRight={index < shown.length - 1}
          showGrip={hovered === key && !dragging}
          dragging={!!dragging}
          showFirstTabTip={firstTabTip === key}
          onMove={(delta) => move(key, delta)}
        />
      ),
    };
  });

  const renderTabBar: TabsProps['renderTabBar'] = onReorder
    ? (tabBarProps, DefaultTabBar) => (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={({ active }) => {
            setDragging(active.id as BoardView);
            setFirstTabTip(null);
          }}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <SortableContext items={shown} strategy={horizontalListSortingStrategy}>
            <DefaultTabBar {...tabBarProps}>
              {(node) => (
                <SortableTabNode
                  {...(node.props as TabNodeProps)}
                  key={node.key}
                  dragging={dragging === node.key}
                  onMoveKey={move}
                  onMouseEnter={() => setHovered(node.key as BoardView)}
                  onMouseLeave={() => setHovered(null)}
                >
                  {node as TabNodeProps['children']}
                </SortableTabNode>
              )}
            </DefaultTabBar>
          </SortableContext>
        </DndContext>
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
    </div>
  );
};
