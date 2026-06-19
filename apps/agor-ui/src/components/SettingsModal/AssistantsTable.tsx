import type { Board, Branch, Repo, Session, User } from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import { AimOutlined, EditOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Popover, Space, Table, Tooltip, Typography, theme } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { ArchiveActionButton } from '../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import { HighlightMatch } from '../HighlightMatch';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { UserAvatar } from '../metadata/UserAvatar';

interface AssistantsTableProps {
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  sessionsByBranch: Map<string, Session[]>;
  userById: Map<string, User>;
  onArchiveOrDelete?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onRowClick?: (branch: Branch) => void;
  onCreateAssistant?: () => void;
  /** Close the parent Settings modal so the canvas isn't obscured by
   *  it after recenter. Wired by SettingsModal. */
  onClose?: () => void;
}

export const AssistantsTable: React.FC<AssistantsTableProps> = ({
  branchById,
  repoById,
  boardById,
  sessionsByBranch,
  userById,
  onArchiveOrDelete,
  onRowClick,
  onCreateAssistant,
  onClose,
}) => {
  // Assistants ARE branches (just branches flagged via
  // `custom_context.assistant`), so navigation reuses the `/w/<short>/`
  // URL via `goToBranch` — no separate `/assistant/<short>/` route.
  // Reuses the `branchById` prop directly so we don't read the same
  // data twice (props + context).
  const navigation = useAppNavigation({ boardById, branchById });

  const handleRecenter = useCallback(
    (assistant: Branch) => {
      // Close the modal first so the canvas isn't obscured. goToBranch
      // pushes `/w/<short>/`; the URL→state effect handles cross-board
      // switching + recenter.
      onClose?.();
      navigation.goToBranch(assistant.branch_id);
    },
    [onClose, navigation]
  );
  const { token } = theme.useToken();

  const [searchTerm, setSearchTerm] = useState('');

  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);

  const assistants = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const assistantBranches = Array.from(branchById.values())
      .filter((w) => !w.archived && isAssistant(w))
      .sort((a, b) => {
        const nameA = getAssistantConfig(a)?.displayName ?? a.name;
        const nameB = getAssistantConfig(b)?.displayName ?? b.name;
        return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
      });

    if (!term) return assistantBranches;

    return assistantBranches.filter((w) => {
      const config = getAssistantConfig(w);
      const repo = repoById.get(w.repo_id);
      const creator = userById.get(w.created_by);
      const haystacks = [
        config?.displayName,
        w.name,
        w.notes,
        creator?.name,
        creator?.email,
        repo?.name,
        repo?.slug,
      ];
      return haystacks.some((v) => v?.toLowerCase().includes(term));
    });
  }, [branchById, repoById, userById, searchTerm]);

  const columns = [
    {
      title: 'Assistant',
      key: 'assistant',
      width: 220,
      render: (_: unknown, record: Branch) => {
        const config = getAssistantConfig(record);
        return (
          <Space>
            {config?.emoji ? (
              <span style={{ fontSize: 18 }}>{config.emoji}</span>
            ) : (
              <RobotOutlined style={{ color: token.colorInfo }} />
            )}
            <Typography.Text strong>
              <HighlightMatch text={config?.displayName ?? record.name} query={searchTerm} />
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Description',
      key: 'description',
      render: (_: unknown, record: Branch) => {
        const notes = (record.notes ?? '').trim();
        if (!notes) {
          return (
            <Typography.Text type="secondary" italic style={{ fontSize: 12 }}>
              No description
            </Typography.Text>
          );
        }
        const firstLine = notes.split('\n').find((l) => l.trim().length > 0) ?? notes;
        // Cell shows plain first-line ellipsis; popover renders full markdown.
        // MarkdownRenderer's `inline` is currently a no-op (Streamdown still
        // emits block nodes), so plain text is the honest preview here.
        return (
          <Popover
            content={
              <div
                className="markdown-compact"
                style={{
                  maxWidth: 480,
                  maxHeight: 400,
                  overflowY: 'auto',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <MarkdownRenderer content={notes} showControls={false} />
              </div>
            }
            trigger="hover"
            placement="topLeft"
            mouseEnterDelay={0.3}
          >
            <Typography.Text
              type="secondary"
              ellipsis
              style={{
                display: 'block',
                maxWidth: 480,
                fontSize: 12,
                cursor: 'help',
              }}
            >
              <HighlightMatch text={firstLine} query={searchTerm} />
            </Typography.Text>
          </Popover>
        );
      },
    },
    {
      title: 'Creator',
      key: 'creator',
      width: 160,
      render: (_: unknown, record: Branch) => {
        const user = userById.get(record.created_by);
        if (!user || record.created_by === 'anonymous') {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.created_by === 'anonymous' ? 'Anonymous' : 'Unknown User'}
            </Typography.Text>
          );
        }
        return <UserAvatar user={user} showName size="small" />;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 130,
      render: (_: unknown, record: Branch) => (
        <Space size="small">
          {record.board_id && (
            <Tooltip title="Center map on assistant">
              <Button
                type="text"
                size="small"
                icon={<AimOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRecenter(record);
                }}
              />
            </Tooltip>
          )}
          <Tooltip title="Edit assistant">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onRowClick?.(record);
              }}
            />
          </Tooltip>
          <ArchiveActionButton
            tooltip="Archive or delete assistant"
            onClick={() => {
              setSelectedBranch(record);
              setArchiveDeleteModalOpen(true);
            }}
          />
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space
        orientation="vertical"
        size={token.sizeUnit * 2}
        style={{ marginBottom: token.sizeUnit * 2, width: '100%' }}
      >
        <Typography.Text type="secondary">
          Assistants are persistent AI companions backed by a framework repo. They maintain memory,
          orchestrate work across branches, and run on scheduled heartbeats.
        </Typography.Text>
        <Space style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }}>
          <Input
            allowClear
            placeholder="Search assistants..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ maxWidth: token.sizeUnit * 40 }}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={onCreateAssistant}
            disabled={!onCreateAssistant}
          >
            Create Assistant
          </Button>
        </Space>
      </Space>

      {assistants.length === 0 && !searchTerm && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 300,
          }}
        >
          <Empty
            image={<RobotOutlined style={{ fontSize: 48, color: token.colorTextDisabled }} />}
            description="No assistants yet"
          >
            <Typography.Text type="secondary">
              Create an assistant to get started, or use the onboarding wizard.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {(assistants.length > 0 || searchTerm) && (
        <Table
          dataSource={assistants}
          columns={columns}
          rowKey="branch_id"
          pagination={{ pageSize: 10 }}
          size="small"
          onRow={(record) => ({
            onClick: () => onRowClick?.(record),
            style: { cursor: onRowClick ? 'pointer' : 'default' },
          })}
        />
      )}

      {/* Archive/Delete Modal */}
      {selectedBranch && (
        <ArchiveDeleteBranchModal
          open={archiveDeleteModalOpen}
          branch={selectedBranch}
          sessionCount={(sessionsByBranch.get(selectedBranch.branch_id) || []).length}
          environmentRunning={selectedBranch.environment_instance?.status === 'running'}
          onConfirm={(options) => {
            onArchiveOrDelete?.(selectedBranch.branch_id, options);
            setArchiveDeleteModalOpen(false);
            setSelectedBranch(null);
          }}
          onCancel={() => {
            setArchiveDeleteModalOpen(false);
            setSelectedBranch(null);
          }}
        />
      )}
    </div>
  );
};
