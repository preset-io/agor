/**
 * Schedules CRUD list for a branch (§6a of the design doc).
 *
 * Pre-#1253 this was a one-schedule-per-branch form; now it's a list of
 * schedules with create / edit / delete / run-now / runs-drawer.
 */

import type { AgorClient, Branch, MCPServer, Schedule, User } from '@agor-live/client';
import { humanizeCron, shortId } from '@agor-live/client';
import {
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { Button, Empty, Popconfirm, Space, Spin, Switch, Table, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { ScheduleModal } from '../../ScheduleModal';
import { ScheduleRunsPanel } from '../../ScheduleRunsPanel';

const { Text } = Typography;

interface ScheduleTabProps {
  branch: Branch;
  client: AgorClient | null;
  mcpServerById?: Map<string, MCPServer>;
  currentUser?: User | null;
  userById?: Map<string, User>;
  onOpenSession?: (sessionId: string) => void;
}

const formatTimestamp = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString() : '—';

const formatHumanizedCron = (cron: string): string => {
  try {
    return humanizeCron(cron);
  } catch {
    return cron;
  }
};

const ellipsisStyle = {
  display: 'block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const CompactTooltipText: React.FC<{
  children: ReactNode;
  title: ReactNode;
  type?: 'secondary';
  code?: boolean;
  ariaLabel?: string;
}> = ({ children, title, type, code, ariaLabel }) => (
  <Tooltip title={title} mouseEnterDelay={0.4}>
    <Text
      aria-label={ariaLabel}
      code={code}
      type={type}
      style={ellipsisStyle}
      title={typeof children === 'string' ? children : undefined}
    >
      {children}
    </Text>
  </Tooltip>
);

const userLabel = (
  userId: string | null | undefined,
  userById: Map<string, User>,
  currentUser?: User | null
) => {
  if (!userId) return '—';
  const user = userById.get(userId);
  const label = user?.email ?? user?.name ?? shortId(userId);
  return currentUser?.user_id === userId ? `${label} (you)` : label;
};

const ScheduleDetails: React.FC<{
  schedule: Schedule;
  humanizedCron: string;
  userById: Map<string, User>;
  currentUser?: User | null;
}> = ({ schedule, humanizedCron, userById, currentUser }) => (
  <Space direction="vertical" size={2} style={{ maxWidth: 360 }}>
    <Text strong>{schedule.name || 'Untitled schedule'}</Text>
    {schedule.description ? <Text>{schedule.description}</Text> : null}
    <Text>
      <Text strong>Schedule:</Text> {humanizedCron}
    </Text>
    <Text>
      <Text strong>Cron:</Text> <Text code>{schedule.cron_expression}</Text>
    </Text>
    <Text>
      <Text strong>Timezone:</Text>{' '}
      {schedule.timezone_mode === 'utc' ? 'UTC' : schedule.timezone || 'local'}
    </Text>
    <Text>
      <Text strong>Next:</Text> {formatTimestamp(schedule.next_run_at)}
    </Text>
    <Text>
      <Text strong>Last:</Text> {formatTimestamp(schedule.last_run_at)}
    </Text>
    <Text>
      <Text strong>Runs as:</Text> {userLabel(schedule.created_by, userById, currentUser)}
    </Text>
  </Space>
);

export const ScheduleTab: React.FC<ScheduleTabProps> = ({
  branch,
  client,
  mcpServerById = new Map(),
  currentUser,
  userById = new Map(),
  onOpenSession,
}) => {
  const { showError, showSuccess } = useThemedMessage();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [runsPanelSchedule, setRunsPanelSchedule] = useState<Schedule | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const fetchSchedules = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.service('schedules').find({
        query: {
          branch_id: branch.branch_id,
          $sort: { created_at: -1 },
        },
      });
      setSchedules(Array.isArray(result) ? result : result.data);
    } catch (err) {
      console.error('Failed to load schedules:', err);
      showError('Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [client, branch.branch_id, showError]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  // Live updates via Feathers events. The service emits these for every
  // CRUD op, including ones on other branches — filter to ours.
  useEffect(() => {
    if (!client) return;
    const service = client.service('schedules');
    const matchesBranch = (s: Schedule) => s.branch_id === branch.branch_id;
    const onCreated = (s: Schedule) => {
      if (matchesBranch(s)) setSchedules((prev) => [s, ...prev]);
    };
    const onPatched = (s: Schedule) => {
      if (matchesBranch(s)) {
        setSchedules((prev) => prev.map((p) => (p.schedule_id === s.schedule_id ? s : p)));
      }
    };
    const onRemoved = (s: Schedule) => {
      setSchedules((prev) => prev.filter((p) => p.schedule_id !== s.schedule_id));
    };
    service.on('created', onCreated);
    service.on('patched', onPatched);
    service.on('removed', onRemoved);
    return () => {
      service.off('created', onCreated);
      service.off('patched', onPatched);
      service.off('removed', onRemoved);
    };
  }, [client, branch.branch_id]);

  const handleNew = () => {
    setEditingSchedule(null);
    setModalOpen(true);
  };

  const handleEdit = (schedule: Schedule) => {
    setEditingSchedule(schedule);
    setModalOpen(true);
  };

  const handleDelete = async (schedule: Schedule) => {
    if (!client) return;
    try {
      await client.service('schedules').remove(schedule.schedule_id);
      showSuccess(`Schedule "${schedule.name}" deleted`);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to delete schedule');
    }
  };

  const handleRunNow = async (schedule: Schedule) => {
    if (!client) return;
    setRunningId(schedule.schedule_id);
    try {
      await client.service(`schedules/${schedule.schedule_id}/run-now`).create({});
      showSuccess(`Triggered "${schedule.name}"`);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to trigger run');
    } finally {
      setRunningId(null);
    }
  };

  const handleToggleEnabled = async (schedule: Schedule, enabled: boolean) => {
    if (!client) return;
    try {
      await client.service('schedules').patch(schedule.schedule_id, { enabled });
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to update schedule');
    }
  };

  const renderScheduleDetails = useCallback(
    (schedule: Schedule, humanizedCron: string) => (
      <ScheduleDetails
        schedule={schedule}
        humanizedCron={humanizedCron}
        userById={userById}
        currentUser={currentUser}
      />
    ),
    [currentUser, userById]
  );

  const columns: TableColumnsType<Schedule> = [
    {
      title: 'On',
      key: 'enabled',
      width: 50,
      render: (_, s) => (
        <Tooltip title={s.enabled ? 'Disable schedule' : 'Enable schedule'}>
          <Switch
            aria-label={`${s.enabled ? 'Disable' : 'Enable'} schedule ${s.name}`}
            checked={s.enabled}
            onChange={(v) => handleToggleEnabled(s, v)}
            size="small"
          />
        </Tooltip>
      ),
    },
    {
      title: 'Title',
      key: 'name',
      width: 220,
      render: (_, s) => {
        const humanizedCron = formatHumanizedCron(s.cron_expression);
        const tooltip = renderScheduleDetails(s, humanizedCron);
        return (
          <Space direction="vertical" size={0} style={{ display: 'flex', minWidth: 0 }}>
            <CompactTooltipText title={tooltip} ariaLabel={`Schedule title: ${s.name}`}>
              {s.name || 'Untitled schedule'}
            </CompactTooltipText>
            {s.description ? (
              <CompactTooltipText title={tooltip} type="secondary">
                {s.description}
              </CompactTooltipText>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Schedule',
      key: 'cron',
      width: 240,
      render: (_, s) => {
        const humanizedCron = formatHumanizedCron(s.cron_expression);
        const tooltip = renderScheduleDetails(s, humanizedCron);
        return (
          <Space direction="vertical" size={0} style={{ display: 'flex', minWidth: 0 }}>
            <CompactTooltipText title={tooltip}>{humanizedCron}</CompactTooltipText>
            <CompactTooltipText title={tooltip} type="secondary" code>
              {s.cron_expression}
            </CompactTooltipText>
          </Space>
        );
      },
    },
    {
      title: 'Next',
      key: 'next_run_at',
      width: 130,
      render: (_, s) => (
        <CompactTooltipText
          title={
            <Space direction="vertical" size={2}>
              <Text strong>Next run</Text>
              <Text>{formatTimestamp(s.next_run_at)}</Text>
              <Text type="secondary">
                {s.timezone_mode === 'utc' ? 'UTC' : s.timezone || 'local'}
              </Text>
            </Space>
          }
        >
          {formatTimestamp(s.next_run_at)}
        </CompactTooltipText>
      ),
    },
    {
      title: '',
      key: 'details',
      width: 32,
      render: (_, s) => {
        const humanizedCron = formatHumanizedCron(s.cron_expression);
        return (
          <Tooltip title={renderScheduleDetails(s, humanizedCron)}>
            <Button
              type="text"
              size="small"
              icon={<InfoCircleOutlined />}
              aria-label={`Details for schedule ${s.name}`}
            />
          </Tooltip>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_, s) => (
        <Space size={2} wrap={false}>
          <Tooltip title="Run now">
            <Button
              type="text"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={runningId === s.schedule_id}
              disabled={runningId === s.schedule_id}
              onClick={() => handleRunNow(s)}
              aria-label={`Run schedule ${s.name} now`}
            />
          </Tooltip>
          {s.last_run_session_id && onOpenSession ? (
            <Tooltip title={`View last run — ${formatTimestamp(s.last_run_at)}`}>
              <Button
                type="text"
                size="small"
                icon={<HistoryOutlined />}
                onClick={() => onOpenSession(s.last_run_session_id!)}
                aria-label={`View last run for schedule ${s.name}`}
              />
            </Tooltip>
          ) : null}
          <Tooltip title="View runs">
            <Button
              type="text"
              size="small"
              icon={<UnorderedListOutlined />}
              onClick={() => setRunsPanelSchedule(s)}
              aria-label={`View runs for schedule ${s.name}`}
            />
          </Tooltip>
          <Tooltip title="Edit">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(s)}
              aria-label={`Edit schedule ${s.name}`}
            />
          </Tooltip>
          <Popconfirm
            title="Delete schedule?"
            description={`Are you sure you want to delete "${s.name}"?`}
            onConfirm={() => handleDelete(s)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="Delete">
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                danger
                aria-label={`Delete schedule ${s.name}`}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 16, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
          minWidth: 0,
        }}
      >
        <CompactTooltipText
          title={`Schedules for ${branch.name}`}
          ariaLabel={`Schedules for ${branch.name}`}
        >
          Schedules for {branch.name}
        </CompactTooltipText>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleNew}
          style={{ flex: '0 0 auto' }}
        >
          New
        </Button>
      </div>
      {loading ? (
        <Spin />
      ) : schedules.length === 0 ? (
        <Empty
          description={
            <span>
              No schedules yet. Schedule a prompt to fire on a cadence — hourly heartbeats, daily
              summaries, weekly retros.
            </span>
          }
        >
          <Button type="primary" icon={<PlusOutlined />} onClick={handleNew}>
            New schedule
          </Button>
        </Empty>
      ) : (
        <Table<Schedule>
          rowKey="schedule_id"
          dataSource={schedules}
          columns={columns}
          pagination={false}
          size="small"
          tableLayout="fixed"
          style={{ width: '100%' }}
        />
      )}

      <ScheduleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        branchId={branch.branch_id}
        branchName={branch.name}
        schedule={editingSchedule}
        mcpServerById={mcpServerById}
        client={client}
        onSaved={() => fetchSchedules()}
      />

      <ScheduleRunsPanel
        open={runsPanelSchedule !== null}
        onClose={() => setRunsPanelSchedule(null)}
        schedule={runsPanelSchedule}
        client={client}
        onOpenSession={onOpenSession}
      />
    </div>
  );
};
