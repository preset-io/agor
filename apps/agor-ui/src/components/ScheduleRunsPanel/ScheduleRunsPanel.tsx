/**
 * Runs panel for a schedule — shows the last N sessions linked via
 * `sessions.schedule_id`, sorted by `scheduled_run_at` DESC. Opens as
 * an Ant Design Drawer from the schedules list (§6c of the design doc).
 */

import type { AgorClient, Schedule, Session } from '@agor-live/client';
import { Button, Drawer, Empty, Spin, Table, Tag } from 'antd';
import { useCallback, useEffect, useState } from 'react';

const RUNS_LIMIT = 20;

export interface ScheduleRunsPanelProps {
  open: boolean;
  onClose: () => void;
  schedule: Schedule | null;
  client: AgorClient | null;
  /** Open the session in the canvas (host wires routing). */
  onOpenSession?: (sessionId: string) => void;
}

const statusTagColor = (status: Session['status']) => {
  switch (status) {
    case 'completed':
      return 'green';
    case 'failed':
    case 'timed_out':
      return 'red';
    case 'running':
    case 'stopping':
    case 'awaiting_permission':
    case 'awaiting_input':
      return 'blue';
    default:
      return 'default';
  }
};

const formatScheduled = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString() : '—';

const formatDuration = (session: Session) => {
  const start = session.scheduled_run_at;
  const end = session.last_updated ? Date.parse(session.last_updated) : null;
  if (!start || !end || end <= start) return '—';
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
};

export const ScheduleRunsPanel: React.FC<ScheduleRunsPanelProps> = ({
  open,
  onClose,
  schedule,
  client,
  onOpenSession,
}) => {
  const [runs, setRuns] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchRuns = useCallback(async () => {
    if (!client || !schedule?.schedule_id) return;
    setLoading(true);
    try {
      const result = await client.service('sessions').find({
        query: {
          schedule_id: schedule.schedule_id,
          $sort: { scheduled_run_at: -1 },
          $limit: RUNS_LIMIT,
        },
      });
      const data = Array.isArray(result) ? result : result.data;
      setRuns(data);
    } catch (err) {
      console.error('Failed to load schedule runs:', err);
    } finally {
      setLoading(false);
    }
  }, [client, schedule?.schedule_id]);

  useEffect(() => {
    if (open) {
      fetchRuns();
    }
  }, [open, fetchRuns]);

  const columns = [
    {
      title: 'Scheduled',
      key: 'scheduled_run_at',
      render: (s: Session) => formatScheduled(s.scheduled_run_at),
    },
    {
      title: 'Status',
      key: 'status',
      render: (s: Session) => <Tag color={statusTagColor(s.status)}>{s.status}</Tag>,
    },
    {
      title: 'Duration',
      key: 'duration',
      render: (s: Session) => formatDuration(s),
    },
    {
      title: '',
      key: 'open',
      render: (s: Session) =>
        onOpenSession ? (
          <Button type="link" size="small" onClick={() => onOpenSession(s.session_id)}>
            Open
          </Button>
        ) : null,
    },
  ];

  return (
    <Drawer
      title={schedule ? `Runs — ${schedule.name}` : 'Runs'}
      open={open}
      onClose={onClose}
      width={640}
      destroyOnClose
    >
      {loading ? (
        <Spin />
      ) : runs.length === 0 ? (
        <Empty description="No runs yet." />
      ) : (
        <Table
          rowKey="session_id"
          dataSource={runs}
          columns={columns}
          pagination={false}
          size="small"
        />
      )}
    </Drawer>
  );
};
