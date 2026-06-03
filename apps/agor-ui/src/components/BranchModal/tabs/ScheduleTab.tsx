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
  PlayCircleOutlined,
  PlusOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { Button, Empty, Popconfirm, Space, Spin, Switch, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { UserAvatar } from '../../metadata/UserAvatar';
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

  const columns = [
    {
      title: 'On',
      key: 'enabled',
      width: 60,
      render: (s: Schedule) => (
        <Switch checked={s.enabled} onChange={(v) => handleToggleEnabled(s, v)} size="small" />
      ),
    },
    {
      title: 'Name',
      key: 'name',
      render: (s: Schedule) => (
        <Button type="link" onClick={() => setRunsPanelSchedule(s)} style={{ padding: 0 }}>
          {s.name}
        </Button>
      ),
    },
    {
      title: 'When',
      key: 'cron',
      render: (s: Schedule) => <Text>{formatHumanizedCron(s.cron_expression)}</Text>,
    },
    {
      title: 'Scheduled by / run as',
      key: 'created_by',
      render: (s: Schedule) => {
        const user = userById.get(s.created_by);
        if (user) {
          return (
            <Space size={4}>
              <UserAvatar user={user} showName size="small" />
              {currentUser?.user_id === s.created_by && <Text type="secondary">(you)</Text>}
            </Space>
          );
        }
        return <Text type="secondary">{s.created_by ? shortId(s.created_by) : '—'}</Text>;
      },
    },
    {
      title: 'Last run',
      key: 'last_run_at',
      render: (s: Schedule) =>
        s.last_run_session_id && onOpenSession ? (
          <Button type="link" size="small" onClick={() => onOpenSession(s.last_run_session_id!)}>
            {formatTimestamp(s.last_run_at)}
          </Button>
        ) : (
          formatTimestamp(s.last_run_at)
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (s: Schedule) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<PlayCircleOutlined />}
            loading={runningId === s.schedule_id}
            disabled={runningId === s.schedule_id}
            onClick={() => handleRunNow(s)}
            title="Run now"
          />
          <Button
            type="text"
            size="small"
            icon={<UnorderedListOutlined />}
            onClick={() => setRunsPanelSchedule(s)}
            title="View runs"
          />
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(s)}
            title="Edit"
          />
          <Popconfirm
            title="Delete schedule?"
            description={`Are you sure you want to delete "${s.name}"?`}
            onConfirm={() => handleDelete(s)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger title="Delete" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text strong>Schedules for {branch.name}</Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleNew}>
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
        <Table
          rowKey="schedule_id"
          dataSource={schedules}
          columns={columns}
          pagination={false}
          size="small"
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
