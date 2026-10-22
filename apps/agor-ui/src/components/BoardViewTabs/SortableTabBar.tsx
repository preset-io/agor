import type { BoardView } from '@agor-live/client';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TabsProps } from 'antd';
import React, { type RefObject } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { closestCenterWithin } from '../../utils/dndRegion';

type RenderTabBarArgs = Parameters<NonNullable<TabsProps['renderTabBar']>>;
type TabNode = React.ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<unknown> }>;

export interface SortableTabBarProps {
  tabBarProps: RenderTabBarArgs[0];
  DefaultTabBar: RenderTabBarArgs[1];
  views: BoardView[];
  /** The editor wrapping (menu, Alt + arrows), shared with the plain bar shown while this loads. */
  wrapNode: (node: React.ReactElement) => React.ReactElement;
  /** Drops outside this element cancel. */
  regionRef: RefObject<HTMLElement | null>;
  onDragStart: (view: BoardView) => void;
  /** `over` is null when the drop was cancelled or landed outside the row. */
  onDragEnd: (view: BoardView, over: BoardView | null) => void;
  onDragCancel: () => void;
}

/** One rc-tabs tab node made sortable, as in antd's draggable tabs demo. */
const SortableTabNode: React.FC<{ node: TabNode; wrapNode: SortableTabBarProps['wrapNode'] }> = ({
  node,
  wrapNode,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(node.key),
    transition: reducedMotion ? null : undefined,
  });
  return wrapNode(
    React.cloneElement(node, {
      ref: setNodeRef,
      style: {
        ...node.props.style,
        transform: CSS.Translate.toString(transform),
        transition: reducedMotion ? undefined : transition,
        cursor: isDragging ? 'grabbing' : 'grab',
      },
      ...listeners,
    })
  );
};

/**
 * The editors' tab bar with drag to reorder. Loaded on demand, so viewers and
 * the first paint never load dnd-kit.
 */
const SortableTabBar: React.FC<SortableTabBarProps> = ({
  tabBarProps,
  DefaultTabBar,
  views,
  wrapNode,
  regionRef,
  onDragStart,
  onDragEnd,
  onDragCancel,
}) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenterWithin(regionRef)}
      onDragStart={({ active }) => onDragStart(active.id as BoardView)}
      onDragEnd={({ active, over }) =>
        onDragEnd(active.id as BoardView, (over?.id as BoardView | undefined) ?? null)
      }
      onDragCancel={onDragCancel}
    >
      <SortableContext items={views} strategy={horizontalListSortingStrategy}>
        <DefaultTabBar {...tabBarProps}>
          {(node) => <SortableTabNode key={node.key} node={node as TabNode} wrapNode={wrapNode} />}
        </DefaultTabBar>
      </SortableContext>
    </DndContext>
  );
};

export default SortableTabBar;
