import type { ChatCollection, SessionID, UpdateUserInput, User } from '@agor-live/client';
import { getTeammateConfig, shortId } from '@agor-live/client';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Empty, Flex, Input, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById, selectSessionById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTimeSafe } from '../../utils/time';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import {
  createTeammateChatCollection,
  MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION,
  MAX_TEAMMATE_CHAT_COLLECTIONS,
  RECENT_TEAMMATE_CHAT_SESSION_LIMIT,
  readTeammateChatPreferences,
  withTeammateChatPreferences,
} from './preferences';

const { Text } = Typography;

interface SessionChoice {
  value: SessionID;
  label: string;
  context: string;
  status: string;
  updatedAt: string;
  relativeUpdatedAt: string;
  shortSessionId: string;
  searchText: string;
}

export function filterSessionChoices<T extends { searchText: string }>(
  choices: T[],
  search: string,
  limit = RECENT_TEAMMATE_CHAT_SESSION_LIMIT
): T[] {
  const query = search.trim().toLowerCase();
  return query
    ? choices.filter((choice) => choice.searchText.includes(query))
    : choices.slice(0, limit);
}

function compareSessionChoicesByRecency(left: SessionChoice, right: SessionChoice): number {
  const leftTimestamp = Date.parse(left.updatedAt);
  const rightTimestamp = Date.parse(right.updatedAt);
  return (
    (Number.isNaN(rightTimestamp) ? 0 : rightTimestamp) -
    (Number.isNaN(leftTimestamp) ? 0 : leftTimestamp)
  );
}

function makeCollectionId(): string {
  const random = new Uint8Array(12);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(random);
  } else {
    // Collection IDs identify entries inside one user's preferences; they are
    // not authorization tokens. Keep creation functional in restricted or
    // older browser contexts where Web Crypto is unavailable.
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }
  const suffix = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `chat-${Date.now().toString(36)}-${suffix}`;
}

export interface TeammateChatCollectionsModalProps {
  open: boolean;
  currentUser: User | null | undefined;
  preselectedSessionId?: string;
  onClose: () => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => Promise<void>;
}

export function TeammateChatCollectionsModal({
  open,
  currentUser,
  preselectedSessionId,
  onClose,
  onUpdateUser,
}: TeammateChatCollectionsModalProps) {
  const { showError, showSuccess } = useThemedMessage();
  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const [collections, setCollections] = useState<ChatCollection[]>([]);
  const [saving, setSaving] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');

  const eligibleSessions = useMemo<SessionChoice[]>(
    () =>
      Array.from(sessionById.values())
        .flatMap((session) => {
          if (session.archived) return [];
          const branch = branchById.get(session.branch_id);
          if (!branch || branch.archived) return [];
          const teammate = getTeammateConfig(branch);
          const title = getSessionDisplayTitle(session, { includeAgentFallback: true });
          const context = teammate?.displayName
            ? `${teammate.emoji || '💬'} ${teammate.displayName} · ${branch.name}`
            : branch.name;
          const shortSessionId = shortId(session.session_id);
          return [
            {
              value: session.session_id as SessionID,
              label: title,
              context,
              status: session.status,
              updatedAt: session.last_updated,
              relativeUpdatedAt: formatRelativeTimeSafe(session.last_updated) ?? 'Unknown activity',
              shortSessionId,
              searchText: `${title} ${context} ${session.status} ${shortSessionId}`.toLowerCase(),
            },
          ];
        })
        .sort(compareSessionChoicesByRecency),
    [branchById, sessionById]
  );
  const storedPreferences = useMemo(
    () => readTeammateChatPreferences(currentUser?.preferences),
    [currentUser?.preferences]
  );
  const sessionOptions = useMemo(() => {
    const options = filterSessionChoices(eligibleSessions, sessionSearch).map((option) => ({
      ...option,
    }));
    const known = new Set(options.map((option) => option.value));
    const requiredSessionIds = new Set([
      ...storedPreferences.collections.flatMap((collection) => collection.session_ids),
      ...collections.flatMap((collection) => collection.session_ids),
    ]);
    const eligibleById = new Map(eligibleSessions.map((option) => [option.value, option]));
    for (const sessionId of requiredSessionIds) {
      if (!known.has(sessionId)) {
        known.add(sessionId);
        const eligible = eligibleById.get(sessionId);
        options.push(
          eligible ?? {
            value: sessionId,
            label: 'Unavailable session',
            context: 'This session may be archived or inaccessible',
            status: 'unavailable',
            updatedAt: '',
            relativeUpdatedAt: '',
            shortSessionId: shortId(sessionId),
            searchText: String(sessionId).toLowerCase(),
          }
        );
      }
    }
    return options;
  }, [collections, eligibleSessions, sessionSearch, storedPreferences.collections]);

  const preselectedSession = preselectedSessionId
    ? sessionById.get(preselectedSessionId)
    : undefined;

  useEffect(() => {
    if (!open) return;
    const eligibleSessionIds = new Set(eligibleSessions.map((option) => option.value));
    const stored = storedPreferences.collections.map((collection) => ({ ...collection }));
    const requestedSessionId = preselectedSessionId as SessionID | undefined;
    const preselected =
      requestedSessionId && eligibleSessionIds.has(requestedSessionId)
        ? requestedSessionId
        : undefined;
    if (preselected && stored.length === 0) {
      stored.push(createTeammateChatCollection(makeCollectionId(), 'Pinned chats', [preselected]));
    }
    setCollections(stored);
    setSessionSearch('');
  }, [eligibleSessions, open, preselectedSessionId, storedPreferences.collections]);

  const preselectedCollectionIds = preselectedSessionId
    ? collections
        .filter((collection) => collection.session_ids.includes(preselectedSessionId as SessionID))
        .map((collection) => collection.collection_id)
    : [];
  const preselectedWasStored = preselectedSessionId
    ? storedPreferences.collections.some((collection) =>
        collection.session_ids.includes(preselectedSessionId as SessionID)
      )
    : false;

  const updatePreselectedCollections = (collectionIds: Array<string | number | boolean>) => {
    if (!preselectedSessionId) return;
    const selectedCollectionIds = new Set(collectionIds.map(String));
    const selectedSessionId = preselectedSessionId as SessionID;
    setCollections((current) =>
      current.map((collection) => {
        const withoutSession = collection.session_ids.filter((id) => id !== selectedSessionId);
        return {
          ...collection,
          session_ids:
            selectedCollectionIds.has(collection.collection_id) &&
            withoutSession.length < MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION
              ? [...withoutSession, selectedSessionId]
              : withoutSession,
        };
      })
    );
  };

  const addCollection = () => {
    if (collections.length >= MAX_TEAMMATE_CHAT_COLLECTIONS) return;
    setCollections((current) => [
      ...current,
      createTeammateChatCollection(makeCollectionId(), `Chat group ${current.length + 1}`),
    ]);
  };

  const save = async () => {
    if (!currentUser || !onUpdateUser) return;
    const invalid = collections.find((collection) => !collection.name.trim());
    if (invalid) {
      showError('Every chat collection needs a name.');
      return;
    }
    if (preselectedSessionId && !preselectedWasStored && preselectedCollectionIds.length === 0) {
      showError('Choose at least one collection for this session.');
      return;
    }
    setSaving(true);
    try {
      await onUpdateUser(currentUser.user_id, {
        preferences: withTeammateChatPreferences(currentUser.preferences, { collections }),
      });
      showSuccess('Chat collections updated');
      onClose();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to update chat collections');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdaptiveSettingsModal
      title={preselectedSessionId ? 'Add session to chat collections' : 'Manage chat collections'}
      open={open}
      onCancel={onClose}
      onOk={save}
      okText="Save"
      confirmLoading={saving}
      okButtonProps={{ disabled: !currentUser || !onUpdateUser }}
      width={680}
      destroyOnHidden
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Text type="secondary">
          Group any sessions on Home, including conversations from AI teammates and gateway
          channels. Collections store references only; each conversation keeps its original history
          and permissions.
        </Text>

        {preselectedSessionId && collections.length > 0 && (
          <Card size="small" styles={{ body: { padding: 12 } }}>
            <Flex vertical gap={8}>
              <div>
                <Text strong>
                  {preselectedSession
                    ? getSessionDisplayTitle(preselectedSession, { includeAgentFallback: true })
                    : 'Selected session'}
                </Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Saved by session ID, so renaming the conversation will not break this link.
                </Text>
              </div>
              <Checkbox.Group
                aria-label="Collections for selected session"
                value={preselectedCollectionIds}
                options={collections.map((collection) => ({
                  label: collection.name,
                  value: collection.collection_id,
                  disabled:
                    !collection.session_ids.includes(preselectedSessionId as SessionID) &&
                    collection.session_ids.length >= MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION,
                }))}
                onChange={updatePreselectedCollections}
              />
            </Flex>
          </Card>
        )}

        {collections.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No chat collections yet">
            <Button type="primary" icon={<PlusOutlined />} onClick={addCollection}>
              Create collection
            </Button>
          </Empty>
        ) : (
          collections.map((collection) => (
            <Card
              key={collection.collection_id}
              size="small"
              title={
                <Input
                  aria-label="Collection name"
                  value={collection.name}
                  maxLength={60}
                  variant="borderless"
                  onChange={(event) => {
                    const name = event.target.value;
                    setCollections((current) =>
                      current.map((item) =>
                        item.collection_id === collection.collection_id ? { ...item, name } : item
                      )
                    );
                  }}
                />
              }
              extra={
                <Button
                  type="text"
                  danger
                  aria-label={`Delete ${collection.name}`}
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    setCollections((current) =>
                      current.filter((item) => item.collection_id !== collection.collection_id)
                    )
                  }
                />
              }
              styles={{ body: { padding: 12 } }}
            >
              <Select
                mode="multiple"
                aria-label={`Sessions in ${collection.name}`}
                placeholder="Choose conversations"
                value={collection.session_ids}
                options={sessionOptions}
                maxCount={MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION}
                filterOption={false}
                showSearch
                searchValue={sessionSearch}
                onSearch={setSessionSearch}
                onOpenChange={(isOpen) => {
                  if (!isOpen) setSessionSearch('');
                }}
                notFoundContent={
                  sessionSearch ? 'No sessions match your search' : 'No recent sessions available'
                }
                optionRender={(option) => (
                  <Flex vertical gap={2} style={{ paddingBlock: 3 }}>
                    <Flex justify="space-between" align="center" gap={8}>
                      <Text ellipsis strong style={{ minWidth: 0 }}>
                        {option.data.label}
                      </Text>
                      <Tag variant="filled" style={{ margin: 0, flexShrink: 0 }}>
                        {option.data.status}
                      </Tag>
                    </Flex>
                    <Flex justify="space-between" gap={8}>
                      <Text type="secondary" ellipsis style={{ minWidth: 0, fontSize: 11 }}>
                        {option.data.context}
                      </Text>
                      <Text type="secondary" style={{ flexShrink: 0, fontSize: 11 }}>
                        {option.data.relativeUpdatedAt} · {option.data.shortSessionId}
                      </Text>
                    </Flex>
                  </Flex>
                )}
                onChange={(sessionIds) =>
                  setCollections((current) =>
                    current.map((item) =>
                      item.collection_id === collection.collection_id
                        ? { ...item, session_ids: sessionIds as SessionID[] }
                        : item
                    )
                  )
                }
                style={{ width: '100%' }}
                popupMatchSelectWidth
              />
            </Card>
          ))
        )}

        {collections.length > 0 && (
          <Button
            block
            icon={<PlusOutlined />}
            disabled={collections.length >= MAX_TEAMMATE_CHAT_COLLECTIONS}
            onClick={addCollection}
          >
            Add collection
          </Button>
        )}
      </Space>
    </AdaptiveSettingsModal>
  );
}
