import type { BoardView } from '@agor-live/client';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  HolderOutlined,
  LockOutlined,
} from '@ant-design/icons';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Flex, Form, Tag, Tooltip, Typography, theme } from 'antd';
import { useRef } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import {
  availableBoardViews,
  BOARD_VIEW_ICONS,
  BOARD_VIEW_LABELS,
  moveBoardView,
} from '../../utils/boardViews';
import { closestCenterWithin } from '../../utils/dndRegion';

const ROW_HEIGHT = 40;

interface RowProps {
  view: BoardView;
  index: number;
  count: number;
  /** Absent for people who cannot edit the board. */
  onMove?: (view: BoardView, delta: number) => void;
}

// A bordered list of 40px rows; antd's List is deprecated in v6.

const TabOrderRow: React.FC<RowProps> = ({ view, index, count, onMove }) => {
  const { token } = theme.useToken();
  const reducedMotion = usePrefersReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id: view, disabled: !onMove, transition: reducedMotion ? null : undefined });
  const label = BOARD_VIEW_LABELS[view];
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: reducedMotion ? undefined : transition,
        borderTop: index > 0 ? `1px solid ${token.colorBorderSecondary}` : undefined,
        background: token.colorBgContainer,
      }}
    >
      <Flex
        align="center"
        gap={token.marginSM}
        style={{ height: ROW_HEIGHT, paddingInline: token.paddingSM }}
      >
        {onMove && (
          <HolderOutlined
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Drag ${label}`}
            style={{ color: token.colorTextQuaternary, cursor: 'grab' }}
          />
        )}
        {BOARD_VIEW_ICONS[view]}
        <span>{label}</span>
        {index === 0 && <Tag color="success">Opens here</Tag>}
        {onMove && (
          <Flex gap={token.marginXXS} style={{ marginInlineStart: 'auto' }}>
            <Tooltip title="Move up">
              <Button
                type="text"
                size="small"
                aria-label="Move up"
                icon={<ArrowUpOutlined />}
                disabled={index === 0}
                onClick={() => onMove(view, -1)}
              />
            </Tooltip>
            <Tooltip title="Move down">
              <Button
                type="text"
                size="small"
                aria-label="Move down"
                icon={<ArrowDownOutlined />}
                disabled={index === count - 1}
                onClick={() => onMove(view, 1)}
              />
            </Tooltip>
          </Flex>
        )}
      </Flex>
    </li>
  );
};

interface BoardTabOrderFieldProps {
  /** The board's full tab order; only the shown views are listed. */
  value: BoardView[];
  /** Absent for people who cannot edit the board: the list is read-only. */
  onChange?: (order: BoardView[]) => void;
}

/** Board settings > General > Tabs: the shared tab order, first tab first. */
export const BoardTabOrderField: React.FC<BoardTabOrderFieldProps> = ({ value, onChange }) => {
  const { token } = theme.useToken();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const listRef = useRef<HTMLUListElement>(null);
  const shown = availableBoardViews(value);
  const move = onChange
    ? (view: BoardView, delta: number) => onChange(moveBoardView(value, view, delta))
    : undefined;

  return (
    <Form.Item
      label="Tabs"
      help={
        <Flex vertical>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            The first tab is where this board opens for everyone. Everyone can still switch tabs.
          </Typography.Text>
          {!onChange && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <LockOutlined style={{ marginRight: 4 }} />
              Only people who can edit this board can change the order.
            </Typography.Text>
          )}
        </Flex>
      }
    >
      <DndContext
        sensors={sensors}
        // A drop outside the list cancels and changes nothing.
        collisionDetection={closestCenterWithin(listRef)}
        onDragEnd={({ active, over }) => {
          if (!move || !over || active.id === over.id) return;
          const view = active.id as BoardView;
          move(view, shown.indexOf(over.id as BoardView) - shown.indexOf(view));
        }}
      >
        <SortableContext items={shown} strategy={verticalListSortingStrategy}>
          <ul
            ref={listRef}
            aria-label="Tab order"
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadiusLG,
              overflow: 'hidden',
            }}
          >
            {shown.map((view, index) => (
              <TabOrderRow
                key={view}
                view={view}
                index={index}
                count={shown.length}
                onMove={move}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </Form.Item>
  );
};
