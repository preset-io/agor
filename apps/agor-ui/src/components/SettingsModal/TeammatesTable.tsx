import type {
  AgorClient,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { AimOutlined, EditOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Space, Tooltip, Typography, theme } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { ArchiveActionButton } from '../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { ResponsiveTable } from './ResponsiveTable';
import { SettingsActionGroup } from './SettingsActionGroup';
import { SettingsIdentity } from './SettingsIdentity';

interface TeammatesTableProps {
  client?: AgorClient | null;
  currentUser?: User | null;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  sessionsByBranch: Map<string, Session[]>;
  userById: Map<string, User>;
  onArchiveOrDelete?: (branchId: string, options: BranchArchiveOrDeleteOptions) => void;
  onRowClick?: (branch: Branch) => void;
  onCreateTeammate?: () => void;
  /** Close the parent Settings modal so the canvas isn't obscured by
   *  it after recenter. Wired by SettingsModal. */
  onClose?: () => void;
}

export const TeammatesTable: React.FC<TeammatesTableProps> = ({
  client,
  currentUser,
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
        return (
          nameA.localeCompare(nameB, undefined, { sensitivity: 'base' }) ||
          a.branch_id.localeCompare(b.branch_id)
        );
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
        userById.get(w.primary_owner_user_id ?? '')?.name,
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
      render: (_: unknown, record: Branch) => {
        const config = getTeammateConfig(record);
        const repo = repoById.get(record.repo_id);
        return (
          <SettingsIdentity
            name={config?.displayName ?? record.name}
            query={searchTerm}
            icon={config?.emoji || <RobotOutlined />}
            description={
              record.notes?.trim() ? (
                <MarkdownRenderer content={record.notes} showControls={false} />
              ) : undefined
            }
            metadata={
              <Typography.Text
                type="secondary"
                ellipsis={{ tooltip: repo?.name || record.name }}
                style={{ display: 'block', fontSize: token.fontSizeSM }}
              >
                {repo?.name || record.name}
              </Typography.Text>
            }
          />
        );
      },
    },
    {
      title: 'Primary owner',
      key: 'owner',
      width: 140,
      render: (_: unknown, record: Branch) => {
        const owner = userById.get(record.primary_owner_user_id ?? '');
        const name = owner?.name || owner?.email || 'Unavailable user';
        return (
          <Typography.Text ellipsis={{ tooltip: name }} style={{ display: 'block' }}>
            {name}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Board',
      key: 'board',
      width: 120,
      render: (_: unknown, record: Branch) => {
        const name = boardById.get(record.board_id ?? '')?.name || '—';
        return (
          <Typography.Text ellipsis={{ tooltip: name }} style={{ display: 'block' }}>
            {name}
          </Typography.Text>
        );
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
                aria-label="Center map on teammate"
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
              aria-label="Edit teammate"
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
      <ResponsiveSettingsHeader
        description="Teammates are persistent AI companions backed by a framework repo. They maintain memory, orchestrate work across branches, and run on scheduled heartbeats."
        actions={(compact) => (
          <Space wrap style={{ width: compact ? '100%' : undefined }}>
            <Input
              allowClear
              placeholder="Search teammates..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: compact ? '100%' : token.sizeUnit * 40,
                flex: compact ? '1 1 100%' : undefined,
              }}
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
        )}
      />

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
        <ResponsiveTable
          primaryColumnKey="teammate"
          dataSource={teammates}
          columns={columns}
          tableLayout="fixed"
          key={searchTerm}
          rowKey="branch_id"
          pagination={{ defaultPageSize: 10 }}
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
          client={client}
          currentUser={currentUser}
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
