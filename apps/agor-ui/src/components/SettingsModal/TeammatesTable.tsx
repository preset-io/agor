import type {
  AgorClient,
  Board,
  Branch,
  CreateRepoRequest,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { AimOutlined, EditOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Empty,
  Input,
  Popover,
  Space,
  Table,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import type { AgenticToolOption } from '../../types';
import { useThemedMessage } from '../../utils/message';
import { ArchiveActionButton } from '../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import { TeammateTab, type TeammateTabResult } from '../CreateDialog/tabs/TeammateTab';
import { HighlightMatch } from '../HighlightMatch';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { UserAvatar } from '../metadata/UserAvatar';
import { ListPanelHeader } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';

/** Progress reporter passed to the teammate submit handler (mirrors CreateDialog). */
export interface TeammateCreateProgress {
  onStatusChange?: (status: string) => void;
}

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
  /** Creates the teammate from the drill-in form; must NOT close Settings. */
  onCreateTeammate?: (
    result: TeammateTabResult,
    progress?: TeammateCreateProgress
  ) => Promise<void>;
  // Deps for the in-place "New teammate" drill-in (mirrors CreateDialog's TeammateTab).
  availableAgents?: AgenticToolOption[];
  onCreateRepo?: (data: CreateRepoRequest) => unknown;
  mcpServerById?: Map<string, MCPServer>;
  currentUser?: User | null;
  client?: AgorClient | null;
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
  availableAgents = [],
  onCreateRepo,
  mcpServerById,
  currentUser,
  client,
  onClose,
}) => {
  const { showError } = useThemedMessage();
  const { drill, openDrill, closeDrill } = useSettingsDrill();
  const isCreating = drill?.kind === 'teammates' && drill.mode === 'create';
  const teammateFormRef = useRef<(() => Promise<TeammateTabResult | null>) | null>(null);
  const [teammateValid, setTeammateValid] = useState(false);
  const [creatingTeammate, setCreatingTeammate] = useState(false);

  const handleCreateTeammateSubmit = useCallback(async () => {
    const result = await teammateFormRef.current?.();
    if (!result) return; // invalid — TeammateTab surfaces field errors
    setCreatingTeammate(true);
    try {
      await onCreateTeammate?.(result);
      closeDrill();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to create AI teammate');
    } finally {
      setCreatingTeammate(false);
    }
  }, [onCreateTeammate, closeDrill, showError]);
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
            <Typography.Link
              ellipsis
              title={config?.displayName ?? record.name}
              onClick={() => onRowClick?.(record)}
            >
              <HighlightMatch text={config?.displayName ?? record.name} query={searchTerm} />
            </Typography.Link>
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

  // "New teammate" opens in place (drill-in) instead of closing Settings.
  if (isCreating) {
    return (
      <DrillInFrame
        title="New AI teammate"
        saveLabel="Create teammate"
        saving={creatingTeammate}
        saveDisabled={!teammateValid}
        onSave={handleCreateTeammateSubmit}
      >
        <div style={{ maxWidth: 640 }}>
          <Alert
            type="info"
            showIcon
            description="Teammates are persistent AI companions backed by a framework repo."
            style={{ marginBottom: 16 }}
          />
          <TeammateTab
            repoById={repoById}
            onValidityChange={setTeammateValid}
            formRef={teammateFormRef}
            onCreateRepo={onCreateRepo}
            availableAgents={availableAgents}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            client={client}
          />
        </div>
      </DrillInFrame>
    );
  }

  return (
    <div>
      <ListPanelHeader
        title="Teammates"
        description="Teammates are persistent AI companions backed by a framework repo. They maintain memory, orchestrate work across branches, and run on scheduled heartbeats."
        search={
          <Input
            allowClear
            placeholder="Search teammates..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ maxWidth: token.sizeUnit * 40 }}
          />
        }
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openDrill({ kind: 'teammates', mode: 'create' })}
            disabled={!onCreateTeammate}
          >
            Create AI teammate
          </Button>
        }
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
        <Table
          dataSource={teammates}
          columns={columns}
          rowKey="branch_id"
          pagination={{ pageSize: 10 }}
          size="small"
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
