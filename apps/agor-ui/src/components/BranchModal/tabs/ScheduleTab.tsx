/**
 * Schedule tab placeholder.
 *
 * The pre-#1253 per-branch schedule UI was driven by the
 * `branches.schedule_*` columns + `branches.data.schedule` blob; those
 * are gone. The first-class CRUD list + modal land in checkpoint 5 of
 * #1253. This stub keeps the tab compiling in the interim.
 */
import type { Branch } from '@agor-live/client';
import { Alert, Typography } from 'antd';

const { Paragraph } = Typography;

interface ScheduleTabProps {
  branch: Branch;
}

export const ScheduleTab: React.FC<ScheduleTabProps> = ({ branch }) => {
  return (
    <div style={{ padding: 16 }}>
      <Alert
        type="info"
        showIcon
        message="Schedules are moving."
        description={
          <Paragraph style={{ margin: 0 }}>
            The single-schedule-per-branch UI has been replaced with first-class CRUD: a branch can
            now own multiple schedules (hourly heartbeat + daily summary, etc.). The new list +
            modal will land here next. Until then, manage schedules via{' '}
            <code>agor_schedules_*</code> MCP tools or <code>POST /schedules</code>. (Branch:{' '}
            <strong>{branch.name}</strong>)
          </Paragraph>
        }
      />
    </div>
  );
};
