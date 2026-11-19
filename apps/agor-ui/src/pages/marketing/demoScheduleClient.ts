// Demo-only stub AgorClient for the real ScheduleTab.tsx (BranchModal's
// schedule config list — cron expression, next/last run, run-now). Covers
// exactly the service calls ScheduleTab's list view makes; "Run now" is
// answered with a resolved promise so the real loading-spinner-then-success
// interaction plays out without any actual scheduler side effect.

import type { User } from '@agor-live/client';
import { ROLES } from '@agor-live/client';
import { demoSchedule } from './demoScheduleData';

export const DEMO_SCHEDULE_USER = {
  user_id: 'demo-user-rin',
  name: 'Rin',
  email: 'rin@example.com',
  emoji: '🧪',
  role: ROLES.ADMIN,
} as unknown as User;

const noop = () => undefined;
const emitter = () => ({ on: noop, off: noop, removeListener: noop });

export function createDemoScheduleClient() {
  const service = (path: string) => {
    if (path === 'schedules') {
      return { find: async () => [demoSchedule], ...emitter() };
    }
    if (path.startsWith('schedules/') && path.endsWith('/run-now')) {
      return { create: async () => ({ triggered: true }), ...emitter() };
    }
    if (path === 'users') {
      return { findAll: async () => [DEMO_SCHEDULE_USER], ...emitter() };
    }
    throw new Error(`demoScheduleClient: unstubbed service "${path}"`);
  };

  return {
    service,
    io: emitter(),
  };
}
