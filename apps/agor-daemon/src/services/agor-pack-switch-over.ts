/**
 * "Switch over" on the SOURCE install after a teammate moved to Agor Cloud:
 * pause the teammate's schedules and gateway channels so the two copies don't
 * both post to Slack or run the same cron. Undo re-enables exactly what was
 * paused. No network between installs: each side is a local action.
 */

import {
  BranchRepository,
  GatewayChannelRepository,
  runWithTenantDatabaseScope,
  ScheduleRepository,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import {
  type AgorPackSwitchOverState,
  type AuthenticatedParams,
  type Branch,
  isTeammate,
  type UserRole,
} from '@agor/core/types';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { type AgorPackServiceContext, readSwitchOverState } from './agor-pack-export.js';

export interface SwitchOverResult {
  branch_id: string;
  switch_over: AgorPackSwitchOverState | null;
  warnings: string[];
}

export async function switchOverTeammate(
  ctx: AgorPackServiceContext,
  params: AuthenticatedParams,
  branchId: string,
  undo: boolean
): Promise<SwitchOverResult> {
  const unit = <T>(work: () => Promise<T>) =>
    runWithTenantDatabaseScope(ctx.db, ctx.tenantId, work);
  const branches = new BranchRepository(ctx.db);
  const branch = (await unit(() => branches.findById(branchId))) as Branch | null;
  if (!branch || !isTeammate(branch)) throw new BadRequest('Teammate not found');
  await unit(() =>
    ensureBranchWorkspaceAccess(
      branches,
      branch,
      ctx.user.user_id,
      ctx.user.role as UserRole,
      'all',
      'read',
      ctx.config.execution?.allow_superadmin === true
    )
  );
  const warnings: string[] = [];
  const current = readSwitchOverState(branch);
  const schedules = ctx.app.service('schedules');
  const channels = ctx.app.service('gateway-channels');
  let next: AgorPackSwitchOverState | null;

  if (!undo) {
    if (current) return { branch_id: branchId, switch_over: current, warnings };
    const disabledSchedules: string[] = [];
    for (const schedule of await unit(() =>
      new ScheduleRepository(ctx.db).findByBranchId(branch.branch_id)
    )) {
      if (!schedule.enabled) continue;
      await schedules.patch(schedule.schedule_id, { enabled: false }, params);
      disabledSchedules.push(schedule.schedule_id);
    }
    const disabledChannels: string[] = [];
    const targeting = (
      await unit(() => new GatewayChannelRepository(ctx.db).findDisplayAll())
    ).filter((channel) => channel.target_branch_id === branch.branch_id && channel.enabled);
    for (const channel of targeting) {
      try {
        await channels.patch(channel.id, { enabled: false }, params);
        disabledChannels.push(channel.id);
      } catch {
        warnings.push(
          `Ask an admin to disable the ${channel.channel_type} channel "${channel.name}".`
        );
      }
    }
    next = {
      switched_at: new Date().toISOString(),
      switched_by: ctx.user.user_id,
      disabled_schedule_ids: disabledSchedules,
      disabled_channel_ids: disabledChannels,
    };
  } else {
    if (!current) return { branch_id: branchId, switch_over: null, warnings };
    for (const id of current.disabled_schedule_ids) {
      await schedules.patch(id, { enabled: true }, params).catch(() => {
        warnings.push('A paused schedule no longer exists.');
      });
    }
    for (const id of current.disabled_channel_ids) {
      await channels.patch(id, { enabled: true }, params).catch(() => {
        warnings.push('A paused gateway channel could not be re-enabled.');
      });
    }
    next = null;
  }

  const { move_to_cloud: _previous, ...context } = (branch.custom_context ?? {}) as Record<
    string,
    unknown
  >;
  await ctx.app
    .service('branches')
    .patch(
      branch.branch_id,
      { custom_context: next ? { ...context, move_to_cloud: next } : context },
      params
    );
  return { branch_id: branchId, switch_over: next, warnings };
}
