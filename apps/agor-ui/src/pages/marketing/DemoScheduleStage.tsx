// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Staged Schedule panel for the demo-video "scheduleFiring" scene — the REAL
// ScheduleTab.tsx (cron expression, humanized schedule, next/last run,
// enabled toggle, run-now), not a session-list row standing in for it. See
// demoScheduleClient.ts for the stub client backing it.

import { theme } from 'antd';
import { ScheduleTab } from '../../components/BranchModal/tabs/ScheduleTab';
import { createDemoScheduleClient, DEMO_SCHEDULE_USER } from './demoScheduleClient';
import { DEMO_SCHEDULE_BRANCH_ID } from './demoScheduleData';
import { demoBranches } from './fixtureData';

const DEMO_CLIENT = createDemoScheduleClient();
const DEMO_USER_BY_ID = new Map([[DEMO_SCHEDULE_USER.user_id, DEMO_SCHEDULE_USER]]);
const DEMO_SCHEDULE_BRANCH = demoBranches.find((b) => b.branch_id === DEMO_SCHEDULE_BRANCH_ID);

export const DemoScheduleStage = () => {
  const { token } = theme.useToken();
  if (!DEMO_SCHEDULE_BRANCH) return null;

  return (
    <div
      data-testid="demo-schedule-stage"
      style={{
        position: 'absolute',
        top: '22%',
        left: '18%',
        right: '18%',
        height: 340,
        zIndex: 30,
        borderRadius: token.borderRadiusLG,
        overflow: 'auto',
        background: token.colorBgElevated,
        boxShadow: '0 24px 90px rgba(0, 0, 0, 0.5)',
        border: `1px solid ${token.colorBorder}`,
      }}
    >
      <ScheduleTab
        branch={DEMO_SCHEDULE_BRANCH}
        // biome-ignore lint/suspicious/noExplicitAny: demo-only stub client, not a real AgorClient
        client={DEMO_CLIENT as any}
        currentUser={DEMO_SCHEDULE_USER}
        userById={DEMO_USER_BY_ID}
      />
    </div>
  );
};
