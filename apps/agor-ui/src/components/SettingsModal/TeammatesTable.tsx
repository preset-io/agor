import type { Board, Branch, Repo, Session, User } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { AimOutlined, EditOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Popover, Space, Table, Tooltip, Typography, theme } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { ArchiveActionButton } from '../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import { HighlightMatch } from '../HighlightMatch';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { UserAvatar } from '../metadata/UserAvatar';
import { SettingsActionGroup } from './SettingsActionGroup';

interface TeammatesTableProps {
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
  onCreateTeammate?: () => void;
  /** Close the parent Settings modal so the canvas isn't obscured by
   *  it after recenter. Wired by SettingsModal. */
  onClose?: () => void;
}

export const TeammatesTable: React.FC<TeammatesTableProps> = ({
  branchById,
  repoById,
  boardById,
  sessionsByBranch,
  userById,
  onArchiveOrDelete,
  onRowClick,
  onCreateTeammate,
  onClose,
}) => {
  // Teammates ARE branches (just branches flagged via
  // `custom_context.teammate`), so navigation reuses the `/w/<short>/`
  // URL via `goToBranch` — no separate `/teammate/<short>/` route.
  // Reuses the `branchById` prop directly so we don't read the same
  // data twice (props + context).
  const navigation = useAppNavigation({ boardById, branchById });

  const handleRecenter = useCallback(
    (teammate: Branch) => {
      // Close the modal first so the canvas isn't obscured. goToBranch
      // pushes `/w/<short>/`; the URL→state effect handles cross-board
      // switching + recenter.
      onClose?.();
      navigation.goToBranch(teammate.branch_id);
    },
    [onClose, navigation]
  );
  const { token } = theme.useToken();

  const [searchTerm, setSearchTerm] = useState('');

  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);

  const teammates = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const teammateBranches = Array.from(branchById.values())
      .filter((w) => !w.archived && isTeammate(w))
      .sort((a, b) => {
        const nameA = getTeammateConfig(a)?.displayName ?? a.name;
        const nameB = getTeammateConfig(b)?.displayName ?? b.name;
        return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
      });

    if (!term) return teammateBranches;

    return teammateBranches.filter((w) => {
      const config = getTeammateConfig(w);
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
      title: 'Teammate',
      key: 'teammate',
      width: 220,
      render: (_: unknown, record: Branch) => {
        const config = getTeammateConfig(record);
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
      width: 104,
      render: (_: unknown, record: Branch) => (
        <SettingsActionGroup>
          {record.board_id && (
            <Tooltip title="Center map on teammate">
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
          <Tooltip title="Edit teammate">
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
            tooltip="Archive or delete teammate"
            onClick={() => {
              setSelectedBranch(record);
              setArchiveDeleteModalOpen(true);
            }}
          />
        </SettingsActionGroup>
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
          Teammates are persistent AI companions backed by a framework repo. They maintain memory,
          orchestrate work across branches, and run on scheduled heartbeats.
        </Typography.Text>
        <Space style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }}>
          <Input
            allowClear
            placeholder="Search teammates..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ maxWidth: token.sizeUnit * 40 }}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={onCreateTeammate}
            disabled={!onCreateTeammate}
          >
            Create AI teammate
          </Button>
        </Space>
      </Space>

      {teammates.length === 0 && !searchTerm && (
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
            description="No teammates yet"
          >
            <Typography.Text type="secondary">
              Create an AI teammate to get started, or use the onboarding wizard.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {(teammates.length > 0 || searchTerm) && (
        <Table
          dataSource={teammates}
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
