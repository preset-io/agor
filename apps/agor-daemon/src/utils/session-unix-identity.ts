import type { AgorExecutionSettings } from '@agor/core/config';
import { unixUserModeRequiresUsername } from '@agor/core/config';
import {
  assertTenantWritable,
  runWithTenantDatabaseScope,
  type TaskDispatchClaimResult,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import type { InternalUser, Session, Task, TaskPendingDispatchStatus } from '@agor/core/types';
import { isTaskPendingDispatch } from '@agor/core/types';

type SessionUnixIdentity = Pick<Session, 'created_by' | 'unix_username'>;

type SessionCreatorLookup = {
  findById(id: string): Promise<Pick<InternalUser, 'unix_username'> | null>;
};

/** Refuse execution when a Session's immutable Unix identity no longer matches its creator. */
export async function assertSessionUnixIdentityMatchesCreator(
  session: SessionUnixIdentity,
  usersRepository: SessionCreatorLookup
): Promise<void> {
  const creator = await usersRepository.findById(session.created_by);
  if (!creator) {
    throw new Forbidden(`Session creator not found: ${session.created_by}`);
  }

  const stampedUnixUsername = session.unix_username ?? null;
  const currentUnixUsername = creator.unix_username ?? null;
  if (currentUnixUsername !== stampedUnixUsername) {
    throw new Forbidden(
      `Session security context has changed. ` +
        `Session was created with unix_username="${stampedUnixUsername ?? 'null'}" ` +
        `but creator's current unix_username="${currentUnixUsername ?? 'null'}". ` +
        `Cannot execute this session with a different unix user. ` +
        `SDK session data is stored in the original user's home directory and cannot be accessed.`
    );
  }
}

interface PendingTaskLaunchInput {
  db: TenantScopeAwareDatabase;
  tenantId: string;
  execution: AgorExecutionSettings | undefined;
  task: Task;
  session: SessionUnixIdentity;
  claimDispatch: (
    task: Task & { status: TaskPendingDispatchStatus }
  ) => Promise<TaskDispatchClaimResult>;
  onClaimed: (task: Task) => Promise<Task>;
  onClaimNotWon: (claim: TaskDispatchClaimResult) => Promise<Task>;
}

/**
 * Run the pending check, point-in-time Unix identity fence, and durable claim in
 * production order, then continue outside the short tenant transaction.
 */
export async function launchPendingTask({
  db,
  tenantId,
  execution,
  task,
  session,
  claimDispatch,
  onClaimed,
  onClaimNotWon,
}: PendingTaskLaunchInput): Promise<Task> {
  if (!isTaskPendingDispatch(task)) return task;

  const dispatchClaim = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    await assertTenantWritable(tenantDb, tenantId);
    const unixUserMode = execution?.unix_user_mode ?? 'simple';
    if (unixUserModeRequiresUsername(unixUserMode)) {
      // Fresh point-in-time fence only: user updates are not locked across the later spawn.
      await assertSessionUnixIdentityMatchesCreator(session, new UsersRepository(tenantDb));
    }
    return claimDispatch(task);
  });

  return dispatchClaim.outcome === 'claimed'
    ? onClaimed(dispatchClaim.task)
    : onClaimNotWon(dispatchClaim);
}
