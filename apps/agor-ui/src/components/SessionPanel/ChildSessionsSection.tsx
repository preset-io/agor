import type { Session } from '@agor-live/client';
import { BranchesOutlined } from '@ant-design/icons';
import { Badge, Collapse, ConfigProvider, Space, Spin, Tree, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppLiveData } from '../../contexts/AppDataContext';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { buildSessionTree, type SessionTreeNode } from '../BranchCard/buildSessionTree';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
import { ToolIcon } from '../ToolIcon';

interface ChildSessionsSectionProps {
  session: Session;
}

/**
 * Collapsible section showing all sessions spawned or forked from this session.
 * Uses a BFS traversal across same-branch sessions and cross-branch genealogy IDs
 * so children always appear regardless of how they were created.
 */
export const ChildSessionsSection: React.FC<ChildSessionsSectionProps> = ({ session }) => {
  const { token } = theme.useToken();
  const { onSessionClick } = useAppActions();
  const { sessionById, sessionsByBranch } = useAppLiveData();
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

  const descendantSessions = useMemo(() => {
    const branchSessions = sessionsByBranch.get(session.branch_id) ?? [];
    const result = new Map<string, Session>();
    const queue: string[] = [];

    // Direct children in the same branch
    for (const s of branchSessions) {
      if (
        s.session_id !== session.session_id &&
        (s.genealogy?.parent_session_id === session.session_id ||
          s.genealogy?.forked_from_session_id === session.session_id)
      ) {
        result.set(s.session_id, s);
        queue.push(s.session_id);
      }
    }

    // Direct children tracked in genealogy.children (covers cross-branch spawns)
    for (const id of session.genealogy?.children ?? []) {
      if (!result.has(id)) {
        const s = sessionById.get(id);
        if (s) {
          result.set(id, s);
          queue.push(id);
        }
      }
    }

    // BFS for all descendants
    while (queue.length > 0) {
      const id = queue.shift()!;
      const s = result.get(id);
      if (!s) continue;

      for (const child of branchSessions) {
        if (
          !result.has(child.session_id) &&
          (child.genealogy?.parent_session_id === id ||
            child.genealogy?.forked_from_session_id === id)
        ) {
          result.set(child.session_id, child);
          queue.push(child.session_id);
        }
      }

      for (const childId of s.genealogy?.children ?? []) {
        if (!result.has(childId)) {
          const child = sessionById.get(childId);
          if (child) {
            result.set(childId, child);
            queue.push(childId);
          }
        }
      }
    }

    return Array.from(result.values());
  }, [session, sessionById, sessionsByBranch]);

  const treeData = useMemo(() => buildSessionTree(descendantSessions), [descendantSessions]);

  useEffect(() => {
    const collectParentKeys = (nodes: SessionTreeNode[]): React.Key[] => {
      const keys: React.Key[] = [];
      for (const node of nodes) {
        if (node.children && node.children.length > 0) {
          keys.push(node.key);
          keys.push(...collectParentKeys(node.children));
        }
      }
      return keys;
    };
    setExpandedKeys(collectParentKeys(treeData));
  }, [treeData]);

  if (descendantSessions.length === 0) return null;

  const renderSessionNode = (node: SessionTreeNode) => {
    const s = node.session;
    const isActive = s.status === 'running' || s.status === 'stopping';
    const title = getSessionDisplayTitle(s, {
      includeAgentFallback: true,
      includeIdFallback: true,
    });

    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 0',
          cursor: onSessionClick ? 'pointer' : 'default',
          opacity: s.archived ? 0.55 : 1,
        }}
        onClick={() => onSessionClick?.(s.session_id)}
      >
        {isActive ? <Spin size="small" /> : <ToolIcon tool={s.agentic_tool} size={16} />}
        <SessionRelationshipIcon session={s} size={10} />
        <Typography.Text
          style={{
            fontSize: 12,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          type={s.archived ? 'secondary' : undefined}
        >
          {title}
          {s.archived && (
            <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
              (archived)
            </Typography.Text>
          )}
        </Typography.Text>
      </div>
    );
  };

  const header = (
    <Space size={4} align="center">
      <BranchesOutlined style={{ fontSize: 12 }} />
      <Typography.Text strong style={{ fontSize: 13 }}>
        Child sessions
      </Typography.Text>
      <Badge
        count={descendantSessions.length}
        showZero
        style={{ backgroundColor: token.colorPrimaryBgHover, color: token.colorText }}
      />
    </Space>
  );

  return (
    <Collapse
      defaultActiveKey={['child-sessions']}
      items={[
        {
          key: 'child-sessions',
          label: header,
          children: (
            <ConfigProvider theme={{ components: { Tree: { colorBgContainer: 'transparent' } } }}>
              <Tree
                className="agor-flat-tree"
                treeData={treeData}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys as React.Key[])}
                showLine
                showIcon={false}
                selectable={false}
                style={{ background: 'transparent', padding: 0 }}
                titleRender={renderSessionNode}
              />
            </ConfigProvider>
          ),
          styles: { body: { background: 'transparent', paddingInline: 0, paddingBlock: 4 } },
        },
      ]}
      ghost
      style={{ flexShrink: 0, marginTop: 4 }}
    />
  );
};
