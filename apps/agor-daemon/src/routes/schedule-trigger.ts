/**
 * `POST /schedules/:id/trigger`: start a schedule's run from its trigger token.
 *
 * Unauthenticated by user session: the bearer token is the whole credential.
 * The request body is ignored and never reaches the prompt. Unknown schedule
 * and wrong token are indistinguishable (404). The scheduler resolves the
 * tenant from the token hash and opens its own short tenant units, so no
 * tenant identity is taken from the request.
 */

import type { Application } from '@agor/core/feathers';
import { Conflict, NotFound } from '@agor/core/feathers';
import type { HookContext, Params, ScheduleID, ScheduleTriggerResult } from '@agor/core/types';
import { parseScheduleTriggerBearer } from '../services/schedule-trigger-token.js';
import {
  ScheduleNotReadyError,
  type SchedulerService,
  ScheduleTriggerNotFoundError,
} from '../services/scheduler.js';

export const SCHEDULE_TRIGGER_ROUTE = '/schedules/:id/trigger';

export function registerScheduleTriggerRoute(app: Application): void {
  app.use(SCHEDULE_TRIGGER_ROUTE, {
    async create(
      _data: unknown,
      params: Params & { route?: { id?: string } }
    ): Promise<ScheduleTriggerResult> {
      const id = params.route?.id;
      const token = parseScheduleTriggerBearer(params.headers);
      if (!id || !token) throw new NotFound('Schedule trigger not found');

      const scheduler = app.get('scheduler') as SchedulerService | undefined;
      if (!scheduler) throw new NotFound('Scheduler service is not enabled on this instance.');
      try {
        return await scheduler.triggerSchedule(id as ScheduleID, token);
      } catch (err) {
        if (err instanceof ScheduleTriggerNotFoundError) {
          throw new NotFound('Schedule trigger not found');
        }
        if (err instanceof ScheduleNotReadyError) {
          throw new Conflict(err.message, { code: err.code });
        }
        throw err;
      }
    },
  });
  app.service(SCHEDULE_TRIGGER_ROUTE).hooks({
    after: {
      create: [
        (context: HookContext) => {
          context.http = { ...context.http, status: 202 };
          return context;
        },
      ],
    },
  });
}
