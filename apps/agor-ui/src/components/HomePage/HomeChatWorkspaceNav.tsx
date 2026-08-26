import type { Branch, Session } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import {
  AimOutlined,
  ArrowLeftOutlined,
  CheckOutlined,
  DownOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  RightOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Button, Empty, Flex, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById, selectSessionById, selectUserById } from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTimeSafe } from '../../utils/time';
import { readTeammateChatPreferences } from '../TeammateChatCollections/preferences';
import { StatusDot } from './StatusDot';

const { Text, Title } = Typography;

interface ChatSidebarBranch {
  key: string;
  branch: Branch;
  sessions: Array<{ session: Session; pinned: boolean }>;
  pinnedCount: number;
}

interface ChatSidebarCollection {
  key: string;
  collectionId: string;
  name: string;
  branches: ChatSidebarBranch[];
  sessionCount: number;
}

export interface HomeChatWorkspaceNavProps {
  currentUserId?: string;
  activeSessionId?: string | null;
  onSessionClick: (sessionId: string) => void;
  onManage: (sessionId?: string) => void;
  onExit: () => void;
  onShowOnBoard: (sessionId: string) => void;
}

export function HomeChatWorkspaceNav({
  currentUserId,
  activeSessionId,
  onSessionClick,
  onManage,
  onExit,
  onShowOnBoard,
}: HomeChatWorkspaceNavProps) {
  const { token } = theme.useToken();
  const userById = useAgorStore(selectUserById);
  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const currentUserPreferences = currentUserId
    ? userById.get(currentUserId)?.preferences
    : undefined;
  const preferences = useMemo(
    () => readTeammateChatPreferences(currentUserPreferences),
    [currentUserPreferences]
  );
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const initializedExpansion = useRef(false);

  const sidebarCollections = useMemo<ChatSidebarCollection[]>(
    () =>
      preferences.collections.map((collection) => {
        const sessionsByBranch = new Map<string, Session[]>();
        const recentSessions = collection.session_ids
          .flatMap((sessionId) => {
            const session = sessionById.get(sessionId);
            return session ? [session] : [];
          })
          .sort((left, right) => Date.parse(right.last_updated) - Date.parse(left.last_updated));
        for (const session of recentSessions) {
          if (session.archived) continue;
          const branch = branchById.get(session.branch_id);
          if (!branch || branch.archived) continue;
          const children = sessionsByBranch.get(branch.branch_id) ?? [];
          children.push(session);
          sessionsByBranch.set(branch.branch_id, children);
        }

        return {
          key: `collection:${collection.collection_id}`,
          collectionId: collection.collection_id,
          name: collection.name,
          sessionCount: Array.from(sessionsByBranch.values()).reduce(
            (total, sessions) => total + sessions.length,
            0
          ),
          branches: Array.from(sessionsByBranch.entries()).map(([branchId, pinnedSessions]) => {
            const pinnedIds = new Set(pinnedSessions.map((session) => session.session_id));
            const sessions = Array.from(sessionById.values())
              .filter(
                (session) =>
                  !session.archived &&
                  session.branch_id === branchId &&
                  branchById.has(session.branch_id)
              )
              .sort((left, right) => Date.parse(right.last_updated) - Date.parse(left.last_updated))
              .slice(0, 50)
              .map((session) => ({ session, pinned: pinnedIds.has(session.session_id) }));
            return {
              key: `branch:${collection.collection_id}:${branchId}`,
              branch: branchById.get(branchId)!,
              sessions,
              pinnedCount: pinnedSessions.length,
            };
          }),
        };
      }),
    [branchById, preferences.collections, sessionById]
  );
  const initiallyExpandedKeys = useMemo(
    () =>
      sidebarCollections.flatMap((collection) => [
        collection.key,
        ...collection.branches.map((branch) => branch.key),
      ]),
    [sidebarCollections]
  );
  useEffect(() => {
    if (sidebarCollections.length === 0) {
      initializedExpansion.current = false;
      setExpandedKeys(new Set());
    } else if (!initializedExpansion.current) {
      initializedExpansion.current = true;
      setExpandedKeys(new Set(initiallyExpandedKeys));
    }
  }, [initiallyExpandedKeys, sidebarCollections.length]);

  const toggleExpanded = (key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const disclosureIcon = (expanded: boolean) =>
    expanded ? (
      <DownOutlined style={{ fontSize: 9, color: token.colorTextTertiary }} />
    ) : (
      <RightOutlined style={{ fontSize: 9, color: token.colorTextTertiary }} />
    );

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgLayout,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Flex vertical gap={3} style={{ padding: '16px 16px 12px' }}>
        <Button
          type="text"
          size="small"
          icon={<ArrowLeftOutlined />}
          onClick={onExit}
          style={{ alignSelf: 'flex-start', marginLeft: -8 }}
        >
          Home
        </Button>
        <Flex justify="space-between" align="center" gap={8}>
          <div style={{ minWidth: 0 }}>
            <Title level={5} style={{ margin: 0 }}>
              Chat workspace
            </Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Pinned sessions
            </Text>
          </div>
          <Flex gap={2}>
            {activeSessionId && (
              <Button
                type="text"
                aria-label="Show active session on board"
                title="Show on board"
                icon={<AimOutlined />}
                onClick={() => onShowOnBoard(activeSessionId)}
              />
            )}
            <Button
              type="text"
              aria-label="Manage chat collections"
              icon={<SettingOutlined />}
              onClick={() => onManage()}
            />
          </Flex>
        </Flex>
      </Flex>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px 16px' }}>
        {sidebarCollections.length > 0 ? (
          <nav aria-label="Chat collections">
            <Flex vertical gap={10}>
              {sidebarCollections.map((collection) => {
                const collectionExpanded = expandedKeys.has(collection.key);
                return (
                  <section key={collection.collectionId}>
                    <button
                      type="button"
                      aria-expanded={collectionExpanded}
                      onClick={() => toggleExpanded(collection.key)}
                      style={{
                        width: '100%',
                        minHeight: 34,
                        display: 'grid',
                        gridTemplateColumns: '14px 20px minmax(0, 1fr) auto',
                        alignItems: 'center',
                        gap: 7,
                        padding: '6px 8px',
                        border: 0,
                        borderRadius: token.borderRadiusLG,
                        background: token.colorFillQuaternary,
                        color: token.colorText,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      {disclosureIcon(collectionExpanded)}
                      <FolderOpenOutlined style={{ color: token.colorTextSecondary }} />
                      <Text strong ellipsis style={{ minWidth: 0, fontSize: 13 }}>
                        {collection.name}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {collection.sessionCount}
                      </Text>
                    </button>

                    {collectionExpanded && (
                      <Flex vertical gap={5} style={{ padding: '6px 0 0 8px' }}>
                        {collection.branches.map(({ key, branch, sessions, pinnedCount }) => {
                          const branchExpanded = expandedKeys.has(key);
                          const teammate = getTeammateConfig(branch);
                          return (
                            <div key={key}>
                              <button
                                type="button"
                                aria-expanded={branchExpanded}
                                onClick={() => toggleExpanded(key)}
                                style={{
                                  width: '100%',
                                  minHeight: 30,
                                  display: 'grid',
                                  gridTemplateColumns: '14px 22px minmax(0, 1fr) auto',
                                  alignItems: 'center',
                                  gap: 6,
                                  padding: '4px 8px',
                                  border: 0,
                                  borderRadius: token.borderRadius,
                                  background: 'transparent',
                                  color: token.colorText,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                }}
                              >
                                {disclosureIcon(branchExpanded)}
                                <span aria-hidden style={{ textAlign: 'center' }}>
                                  {teammate?.emoji || '💬'}
                                </span>
                                <Text ellipsis style={{ minWidth: 0, fontSize: 12 }}>
                                  {teammate?.displayName || branch.name}
                                </Text>
                                <Text type="secondary" style={{ fontSize: 10 }}>
                                  {pinnedCount}/{sessions.length}
                                </Text>
                              </button>

                              {branchExpanded && (
                                <Flex vertical gap={2} style={{ padding: '2px 0 2px 20px' }}>
                                  {sessions.map(({ session, pinned }) => {
                                    const active = session.session_id === activeSessionId;
                                    return (
                                      <div
                                        key={session.session_id}
                                        style={{
                                          width: '100%',
                                          minHeight: 34,
                                          display: 'grid',
                                          gridTemplateColumns: 'minmax(0, 1fr) auto',
                                          alignItems: 'center',
                                          gap: 4,
                                          padding: '2px 4px 2px 8px',
                                          borderRadius: token.borderRadiusLG,
                                          background: active ? token.colorPrimaryBg : 'transparent',
                                          color: active ? token.colorPrimaryText : token.colorText,
                                        }}
                                      >
                                        <button
                                          type="button"
                                          aria-current={active ? 'page' : undefined}
                                          onClick={() =>
                                            pinned
                                              ? onSessionClick(session.session_id)
                                              : onManage(session.session_id)
                                          }
                                          style={{
                                            minHeight: 30,
                                            display: 'grid',
                                            gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                                            alignItems: 'center',
                                            gap: 7,
                                            padding: 0,
                                            border: 0,
                                            background: 'transparent',
                                            color: 'inherit',
                                            cursor: 'pointer',
                                            textAlign: 'left',
                                          }}
                                        >
                                          <StatusDot status={session.status} />
                                          <Text
                                            ellipsis
                                            strong={active || pinned}
                                            style={{
                                              minWidth: 0,
                                              fontSize: 12,
                                              color: pinned ? 'inherit' : token.colorTextSecondary,
                                            }}
                                          >
                                            {getSessionDisplayTitle(session, {
                                              includeAgentFallback: true,
                                            })}
                                          </Text>
                                          <Text
                                            type="secondary"
                                            style={{ fontSize: 10, whiteSpace: 'nowrap' }}
                                          >
                                            {formatRelativeTimeSafe(session.last_updated)}
                                          </Text>
                                        </button>
                                        <Button
                                          type="text"
                                          size="small"
                                          aria-label={
                                            pinned
                                              ? `Manage ${getSessionDisplayTitle(session, { includeAgentFallback: true })} in collection`
                                              : `Add ${getSessionDisplayTitle(session, { includeAgentFallback: true })} to collection`
                                          }
                                          title={
                                            pinned
                                              ? 'Added — manage or remove'
                                              : 'Add to collection'
                                          }
                                          icon={pinned ? <CheckOutlined /> : <PlusOutlined />}
                                          onClick={() => onManage(session.session_id)}
                                          style={{
                                            width: 28,
                                            minWidth: 28,
                                            color: pinned
                                              ? token.colorPrimary
                                              : token.colorTextTertiary,
                                          }}
                                        />
                                      </div>
                                    );
                                  })}
                                </Flex>
                              )}
                            </div>
                          );
                        })}
                      </Flex>
                    )}
                  </section>
                );
              })}
            </Flex>
          </nav>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Pin sessions to build your chat workspace."
            style={{ marginTop: 32 }}
          >
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={onManage}>
              Create collection
            </Button>
          </Empty>
        )}
      </div>
    </div>
  );
}
