// Fixture data for the "scheduleFiring" scene's real ScheduleTab reveal —
// the actual cron config UI (BranchModal/tabs/ScheduleTab.tsx), not just a
// "Scheduled Runs" session-list row. Mirrors docs-freshness-check's fixture
// branch/session in fixtureData.ts (branch id ...108, session-1 completed,
// session-2 the nightly RUNNING crawl).

import type { Schedule } from '@agor/core/types';
import { demoNow } from './fixtureData';

export const DEMO_SCHEDULE_BRANCH_ID = '019ee88d-demo-branch-0000-000000000108';

const nowMs = Date.parse(demoNow);
const ONE_HOUR_MS = 60 * 60 * 1000;

export const demoSchedule: Schedule = {
  schedule_id: '019ee88d-demo-schedule-0000-00000000d001',
  branch_id: DEMO_SCHEDULE_BRANCH_ID,
  name: 'Nightly docs freshness crawl',
  description: 'Crawl the docs site, flag stale code samples against `main`.',
  cron_expression: '0 2 * * *',
  timezone_mode: 'local',
  timezone: 'America/Los_Angeles',
  prompt: 'Crawl the docs site and flag any stale code samples against `main`.',
  agentic_tool_config: { agentic_tool: 'claude-code' },
  enabled: true,
  allow_concurrent_runs: false,
  retention: 10,
  last_run_at: nowMs - 22 * ONE_HOUR_MS,
  last_run_session_id: `${DEMO_SCHEDULE_BRANCH_ID}-session-1`,
  next_run_at: nowMs + 2 * ONE_HOUR_MS,
  created_at: new Date(nowMs - 30 * 24 * ONE_HOUR_MS).toISOString(),
  updated_at: new Date(nowMs - 22 * ONE_HOUR_MS).toISOString(),
  created_by: 'demo-user-rin',
} as unknown as Schedule;
