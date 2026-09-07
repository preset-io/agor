import type { AgorClient } from '@agor-live/client';
import { CloseOutlined, ShrinkOutlined } from '@ant-design/icons';
import { Button, Space, Tooltip, theme } from 'antd';
import React from 'react';
import { useAgorStore } from '../../../store/agorStore';
import {
  selectBranchById,
  selectSessionById,
  selectSessionMcpServerIds,
} from '../../../store/selectors';
import {
  REACT_FLOW_DRAG_HANDLE_CLASS,
  REACT_FLOW_NO_DRAG_CLASS,
} from '../../../utils/reactFlowDragClasses';
import { getSessionDisplayTitle } from '../../../utils/sessionTitle';
import SessionPanel from '../../SessionPanel/SessionPanel';
import { ToolIcon } from '../../ToolIcon';

const EMPTY_STRING_ARRAY: string[] = Object.freeze([] as string[]) as string[];

export interface EjectedSessionNodeData {
  sessionId: string;
  client: AgorClient | null;
  currentUserId?: string;
  /** Called when the user clicks "Re-dock" — removes from canvas and opens in sidebar. */
  onRedock: (sessionId: string) => void;
  /** Called when the user clicks "Close" — removes from canvas; next click opens in sidebar. */
  onClose: (sessionId: string) => void;
}

/**
 * ReactFlow node that renders a full interactive session panel on the board canvas.
 *
 * Drag handle: the top strip (className="drag-handle").
 * Content area: SessionPanel with `isEjected={true}`, which adds drag handle class
 * to the panel header and stop-wheel propagation to the body.
 *
 * All realtime subscriptions, draft persistence, and prompt input are handled
 * by SessionPanel itself — identical to the sidebar variant.
 */
const EjectedSessionNode: React.FC<{ data: EjectedSessionNodeData }> = ({ data }) => {
  const { token } = theme.useToken();

  // Read live data directly from the store — no prop drilling needed.
  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const sessionMcpServerIds = useAgorStore(selectSessionMcpServerIds);

  const session = sessionById.get(data.sessionId) ?? null;
  const branch = session ? (branchById.get(session.branch_id) ?? null) : null;
  const mcpServerIds = sessionMcpServerIds.get(data.sessionId) ?? EMPTY_STRING_ARRAY;

  // Session was deleted/archived while ejected — render nothing.
  if (!session) return null;

  return (
    <div
      style={{
        width: 600,
        height: 700,
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgElevated,
        border: `2px solid ${token.colorPrimaryBorder}`,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadowSecondary,
        overflow: 'hidden',
      }}
    >
      {/* Drag-handle title bar — dragging this moves the node */}
      <div
        className={REACT_FLOW_DRAG_HANDLE_CLASS}
        style={{
          flexShrink: 0,
          padding: '4px 8px',
          background: token.colorPrimaryBg,
          borderBottom: `1px solid ${token.colorPrimaryBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'grab',
          userSelect: 'none',
          minWidth: 0,
        }}
      >
        <Space size={6} style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <ToolIcon tool={session.agentic_tool} size={14} />
          <span
            style={{
              fontSize: 12,
              color: token.colorTextSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {getSessionDisplayTitle(session, { includeAgentFallback: true })}
          </span>
        </Space>
        {/* Buttons must not initiate drag (nodrag class) */}
        <Space size={2} className={REACT_FLOW_NO_DRAG_CLASS}>
          <Tooltip title="Re-dock to sidebar" mouseEnterDelay={0.5}>
            <Button
              type="text"
              size="small"
              icon={<ShrinkOutlined />}
              onClick={() => data.onRedock(data.sessionId)}
              style={{ color: token.colorTextSecondary }}
            />
          </Tooltip>
          <Tooltip title="Close" mouseEnterDelay={0.5}>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={() => data.onClose(data.sessionId)}
              style={{ color: token.colorTextSecondary }}
            />
          </Tooltip>
        </Space>
      </div>

      {/* Full session panel — same component as the sidebar, just sized differently */}
      <div
        className={REACT_FLOW_NO_DRAG_CLASS}
        style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}
        // Prevent canvas wheel-zoom from triggering while scrolling conversation
        onWheel={(e) => e.stopPropagation()}
      >
        <SessionPanel
          client={data.client}
          session={session}
          branch={branch}
          currentUserId={data.currentUserId}
          sessionMcpServerIds={mcpServerIds}
          open={true}
          isEjected={true}
          onClose={() => data.onRedock(data.sessionId)}
        />
      </div>
    </div>
  );
};

export default React.memo(EjectedSessionNode);
