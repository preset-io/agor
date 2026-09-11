import type { Session } from '@agor/core/types';
import { PlusOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Badge, Button, Empty, Popover, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { REACT_FLOW_NO_DRAG_CLASS } from '../../utils/reactFlowDragClasses';
import { formatRelativeTimeSafe } from '../../utils/time';
import { StatusDot } from '../HomePage/StatusDot';

const { Text } = Typography;

export interface CompactSessionPickerProps {
  sessions: Session[];
  branchId: string;
  selectedSessionId?: string | null;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (branchId: string) => void;
  /** Cap on rows rendered before the list scrolls. */
  maxVisible?: number;
}

/**
 * Session list for a collapsed worktree card.
 *
 * A collapsed card hides its session sections, so the only route to a session
 * was to expand the card — which re-flows the zone around it and loses the
 * density the user just asked for. This keeps the card collapsed and puts the
 * sessions one click away instead.
 *
 * Rows are ordered most-recently-updated first, because that is the one the
 * caller almost always wants and scanning a canvas-sized popover for it is
 * the whole cost being avoided.
 */
export const CompactSessionPicker = ({
  sessions,
  branchId,
  selectedSessionId,
  onSessionClick,
  onCreateSession,
  maxVisible = 8,
}: CompactSessionPickerProps) => {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);

  const ordered = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        const left = Date.parse(b.last_updated ?? '') || 0;
        const right = Date.parse(a.last_updated ?? '') || 0;
        return left - right;
      }),
    [sessions]
  );

  const choose = (sessionId: string) => {
    setOpen(false);
    onSessionClick?.(sessionId);
  };

  const rowHeight = 44;
  const content = (
    <div
      className={REACT_FLOW_NO_DRAG_CLASS}
      style={{ width: 280, maxHeight: rowHeight * maxVisible, overflowY: 'auto' }}
    >
      {ordered.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">No sessions yet</Text>}
          style={{ margin: '8px 0' }}
        >
          {onCreateSession && (
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setOpen(false);
                onCreateSession(branchId);
              }}
            >
              New Session
            </Button>
          )}
        </Empty>
      ) : (
        <div role="listbox" aria-label="Sessions">
          {ordered.map((session) => {
            const isSelected = session.session_id === selectedSessionId;
            return (
              <button
                key={session.session_id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => choose(session.session_id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 8px',
                  border: 'none',
                  borderRadius: token.borderRadiusSM,
                  background: isSelected ? token.colorFillSecondary : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <StatusDot status={session.status} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    ellipsis={{ tooltip: session.title || session.session_id }}
                    style={{ display: 'block', fontSize: 12 }}
                    strong={isSelected}
                  >
                    {session.title || 'Untitled session'}
                  </Text>
                </span>
                <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                  {formatRelativeTimeSafe(session.last_updated)}
                </Text>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    // The click is shielded from the card here rather than on the button:
    // Popover listens on the element it clones, so stopping propagation any
    // deeper also stops the popover from ever opening. Bubbling reaches this
    // wrapper only after the popover's own handler has run.
    <span
      className={REACT_FLOW_NO_DRAG_CLASS}
      onClick={(event) => event.stopPropagation()}
      style={{ display: 'inline-flex' }}
    >
      <Popover
        content={content}
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="bottomRight"
      >
        <Badge count={ordered.length} size="small" offset={[-2, 2]} showZero={false}>
          <Button
            type="text"
            size="small"
            aria-label={`Sessions (${ordered.length})`}
            title="Sessions"
            icon={<UnorderedListOutlined />}
          />
        </Badge>
      </Popover>
    </span>
  );
};
