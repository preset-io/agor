import { eq, sql } from 'drizzle-orm';
import {
  type Branch,
  type BranchEnvironmentInstance,
  type BranchID,
  ENVIRONMENT_COMMAND_BUDGET as BUDGET,
  type EnvironmentCommandAction,
  type EnvironmentCommandReport,
  environmentStartConfirmation,
  hasActiveEnvironmentCommand,
  type UserID,
} from '../../types';
import type { Database } from '../client';
import {
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { branches } from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

type Environment = BranchEnvironmentInstance;

/** All transitions serialize on the existing tenant-owned branch row. No provider work here. */
export class EnvironmentCommandRepository {
  constructor(private readonly db: Database) {}

  private async mutate<T>(
    id: BranchID,
    work: (
      environment: Environment,
      now: Date,
      row: typeof branches.$inferSelect
    ) => { value: T; environment?: Environment }
  ): Promise<T> {
    const transaction = () =>
      runDatabaseTransaction(
        this.db,
        async (tx) => {
          await lockRowForUpdate(tx, this.db, branches, eq(branches.branch_id, id));
          const row = await select(tx).from(branches).where(eq(branches.branch_id, id)).one();
          if (!row) throw new EntityNotFoundError('Branch', id);
          const nowRow = isPostgresDatabase(this.db)
            ? await select(tx, { now: sql<Date>`clock_timestamp()` })
                .from(branches)
                .where(eq(branches.branch_id, id))
                .one()
            : undefined;
          const now = nowRow ? new Date(nowRow.now) : new Date();
          const data = row.data as { environment_instance?: Environment };
          const result = work(data.environment_instance ?? { status: 'stopped' }, now, row);
          if (result.environment) {
            await update(tx, branches)
              .set({
                data: { ...row.data, environment_instance: result.environment },
                updated_at: now,
                environment_generation: sql`${branches.environment_generation} + 1`,
                environment_health_claim_token: null,
                environment_health_claim_expires_at: null,
                environment_health_next_observation_at: null,
              })
              .where(eq(branches.branch_id, id))
              .run();
          }
          return result.value;
        },
        { sqliteImmediate: true }
      );
    // Retry only rolled-back database contention, never provider commands.
    // libsql can return SQLITE_BUSY immediately even with a busy timeout.
    for (let retry = 0; ; retry++) {
      try {
        return await transaction();
      } catch (error) {
        if (
          !isSQLiteDatabase(this.db) ||
          !/SQLITE_BUSY|database is locked/i.test(String(error)) ||
          retry >= 9
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (retry + 1)));
      }
    }
  }

  async admit(input: {
    branch: Branch;
    action: EnvironmentCommandAction;
    attemptId: string;
    userId: UserID;
    confirmationOf?: string;
  }): Promise<Environment> {
    return this.mutate(input.branch.branch_id, (previous, now, row) => {
      if (row.archived || (row.filesystem_status && row.filesystem_status !== 'ready')) {
        throw new RepositoryError('Environment commands require a ready, non-archived branch');
      }
      for (const field of [
        'start_command',
        'stop_command',
        'nuke_command',
        'health_check_url',
        'app_url',
        'path',
      ] as const) {
        if (
          ((field === 'path' ? row.data.path : row[field]) ?? undefined) !== input.branch[field]
        ) {
          throw new RepositoryError('Environment configuration changed; refresh before retrying');
        }
      }
      const environment = expireEnvironmentCommand(previous, now);
      if (hasActiveEnvironmentCommand(environment)) {
        throw new RepositoryError(
          'An environment command is still active; wait for its result or deadline'
        );
      }
      const confirmation = environmentStartConfirmation(environment);
      if (input.action === 'start') {
        if (environment.status === 'running' || environment.status === 'starting') {
          throw new RepositoryError(
            'Environment is already running or waiting for health; Stop it first'
          );
        }
        if (
          (confirmation && confirmation !== input.confirmationOf) ||
          (input.confirmationOf && input.confirmationOf !== confirmation)
        ) {
          throw new RepositoryError(
            'Previous environment cleanup is unconfirmed. Refresh and explicitly confirm Start anyway for the current attempt.'
          );
        }
      } else if (input.confirmationOf) {
        throw new RepositoryError('Start confirmation is only valid for Start');
      }
      const commandDeadline = now.getTime() + BUDGET.claimMs + BUDGET.commandMs;
      const next: Environment = {
        ...environment,
        status: input.action === 'start' ? 'starting' : 'stopping',
        command_attempt: {
          id: input.attemptId,
          action: input.action,
          requested_by: input.userId,
          requested_at: now.toISOString(),
          claim_deadline: new Date(now.getTime() + BUDGET.claimMs).toISOString(),
          command_deadline: new Date(commandDeadline).toISOString(),
          result_deadline: new Date(
            commandDeadline + BUDGET.cleanupMs + BUDGET.reportMs
          ).toISOString(),
          ...(input.confirmationOf ? { confirmation_of: input.confirmationOf } : {}),
        },
        command_history: [
          ...(environment.command_history ?? []),
          ...(environment.command_attempt
            ? [{ attempt: environment.command_attempt, result: environment.last_command }]
            : []),
        ].slice(-BUDGET.history),
      };
      delete next.last_health_check;
      delete next.last_command;
      delete next.last_error;
      return { value: next, environment: next };
    });
  }

  async report(report: EnvironmentCommandReport): Promise<Environment> {
    return this.mutate(report.branch_id, (environment, now, row) => {
      const attempt = environment.command_attempt;
      if (
        row.archived ||
        !attempt ||
        attempt.id !== report.attempt_id ||
        attempt.action !== report.action
      ) {
        throw new RepositoryError('Stale environment command report');
      }
      if (report.kind === 'result' && attempt.finished_at) {
        // Duplicate delivery is harmless; it never overwrites the first settlement.
        return { value: environment };
      }
      if (attempt.finished_at || expireEnvironmentCommand(environment, now) !== environment) {
        throw new RepositoryError('Environment command attempt expired or already completed');
      }
      const next: Environment = { ...environment, command_attempt: { ...attempt } };
      if (report.kind === 'claim') {
        if (attempt.claimed_at) throw new RepositoryError('Environment command already claimed');
        next.command_attempt!.claimed_at = now.toISOString();
        // The command receives a full budget from claim, never past the hard admission deadline.
        next.command_attempt!.command_deadline = new Date(
          Math.min(Date.parse(attempt.command_deadline), now.getTime() + BUDGET.commandMs)
        ).toISOString();
      } else {
        if (!attempt.claimed_at)
          throw new RepositoryError('Environment command must be claimed first');
        if (report.kind === 'output') {
          if (report.sequence <= (attempt.output_sequence ?? 0)) return { value: environment };
          next.command_attempt!.output = report.output;
          next.command_attempt!.output_truncated = report.truncated;
          next.command_attempt!.output_sequence = report.sequence;
        } else {
          const settled = settleEnvironmentCommand(
            next,
            report.outcome,
            report.message,
            now,
            report.output,
            report.truncated
          );
          if (report.outcome === 'succeeded' && report.action === 'start') {
            settled.status = row.health_check_url ? 'starting' : 'running';
            settled.last_health_check = {
              timestamp: now.toISOString(),
              status: 'unknown',
              message: row.health_check_url
                ? 'Start command succeeded; waiting for health observation'
                : 'Start command reported success; no health check configured',
            };
            settled.access_urls =
              report.access_urls ?? (row.app_url ? [{ name: 'App', url: row.app_url }] : []);
          }
          return { value: settled, environment: settled };
        }
      }
      return { value: next, environment: next };
    });
  }

  /** Discovery and admission call this independently; no initiating result waiter. */
  async expire(branchId: BranchID): Promise<boolean> {
    return this.mutate(branchId, (environment, now) => {
      const next = expireEnvironmentCommand(environment, now);
      return {
        value: next !== environment,
        ...(next !== environment ? { environment: next } : {}),
      };
    });
  }

  async dispatchFailed(branchId: BranchID, attemptId: string): Promise<void> {
    return this.mutate(branchId, (environment, now) => {
      const attempt = environment.command_attempt;
      // A lost launcher response is not evidence against a claimed runner.
      if (!attempt || attempt.id !== attemptId || attempt.claimed_at || attempt.finished_at)
        return { value: undefined };
      return {
        value: undefined,
        environment: settleEnvironmentCommand(
          environment,
          'unknown',
          'Launch handoff failed or timed out. Remote outcome is unknown; output may be missing. No automatic retry.',
          now
        ),
      };
    });
  }
}

function settleEnvironmentCommand(
  environment: Environment,
  outcome: 'succeeded' | 'failed' | 'unknown',
  message: string,
  now: Date,
  output?: string,
  truncated?: boolean
): Environment {
  const attempt = environment.command_attempt!;
  const next: Environment = {
    ...environment,
    status:
      outcome === 'succeeded' ? (attempt.action === 'start' ? 'starting' : 'stopped') : 'error',
    command_attempt: {
      ...attempt,
      finished_at: now.toISOString(),
      output: output ?? attempt.output,
      output_truncated: truncated ?? attempt.output_truncated,
    },
    last_command: {
      action: attempt.action,
      attempt_id: attempt.id,
      status: outcome,
      timestamp: now.toISOString(),
      message,
      output: output ?? attempt.output,
      output_truncated: truncated ?? attempt.output_truncated,
    },
  };
  delete next.process;
  delete next.last_health_check;
  if (outcome !== 'succeeded') next.last_error = message;
  return next;
}

function expireEnvironmentCommand(environment: Environment, now: Date): Environment {
  const attempt = environment.command_attempt;
  if (!attempt || attempt.finished_at) return environment;
  const deadline = attempt.claimed_at ? attempt.result_deadline : attempt.claim_deadline;
  if (Date.parse(deadline) > now.getTime()) return environment;
  return settleEnvironmentCommand(
    environment,
    'unknown',
    attempt.claimed_at
      ? 'Command result deadline expired. Remote outcome is unknown; available output may be incomplete.'
      : 'Executor did not claim the command before its deadline. Remote outcome is unknown; output may be missing.',
    now
  );
}
