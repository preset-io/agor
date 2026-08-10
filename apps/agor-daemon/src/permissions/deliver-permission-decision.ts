import type { BranchRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type { PermissionDecision } from '@agor/core/permissions';
import type {
  HookContext,
  Message,
  PermissionRequestContent,
  Session,
  SessionID,
  TaskID,
  UUID,
} from '@agor/core/types';
import { PermissionScope, PermissionStatus } from '@agor/core/types';
import { resolveSessionPromptAccess } from '../utils/branch-authorization.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';

export type PermissionDecisionDelivery = PermissionDecision & {
  sessionId: SessionID;
};

/** Legacy clients may still send decidedBy; the server always ignores it. */
export type PermissionDecisionSubmission = Omit<PermissionDecision, 'decidedBy'> & {
  decidedBy?: string;
};

export type PermissionDecisionResult =
  | { success: true }
  | {
      success: false;
      alreadyResolved: true;
      status: PermissionStatus;
      message: string;
    };

export interface PermissionDecisionAuthorization {
  branchRbacEnabled: boolean;
  branchRepository: Pick<BranchRepository, 'findById' | 'isOwner' | 'resolveUserPermission'>;
  allowSuperadmin: boolean;
}

function normalizeScope(data: PermissionDecisionSubmission): {
  remember: boolean;
  scope: PermissionScope;
} {
  if (!data.allow || data.remember !== true) {
    return { remember: false, scope: PermissionScope.ONCE };
  }
  if (
    data.scope !== PermissionScope.PROJECT &&
    data.scope !== PermissionScope.USER &&
    data.scope !== PermissionScope.LOCAL
  ) {
    throw new BadRequest('A persistent permission decision requires a valid scope');
  }
  return { remember: true, scope: data.scope };
}

/**
 * Validate and transiently deliver one UI permission decision to the executor
 * scoped to the persisted permission Message's tenant, Session, and Task.
 *
 * The executor is the commit authority: this function deliberately does not
 * patch the Message or Task. A successful response means the command was
 * admitted for realtime delivery, not that the executor received it. Until
 * the executor commits the Message outcome, the pending UI remains retryable.
 */
export async function deliverPermissionDecision(options: {
  app: Application;
  sessionId: SessionID;
  data: PermissionDecisionSubmission;
  params: HookContext['params'];
  authorization: PermissionDecisionAuthorization;
}): Promise<PermissionDecisionResult> {
  const { app, sessionId, data, params, authorization } = options;
  if (!data.requestId) throw new BadRequest('requestId required');
  if (typeof data.taskId !== 'string' || !data.taskId) throw new BadRequest('taskId required');
  if (typeof data.allow !== 'boolean') throw new BadRequest('allow field required');

  const decidedBy = params.user?.user_id;
  if (!decidedBy) throw new NotAuthenticated('Authentication required');

  // This hooked external read is load-bearing for branch/user authorization,
  // while the route's tenant around-hook and PostgreSQL RLS own tenant
  // isolation. Do not replace it with an unscoped repository lookup.
  const session = (await app.service('sessions').get(sessionId, params)) as Session;

  // Viewing a Session is not sufficient to control its executor. Permission
  // decisions share the prompt policy: prompt/all can control any Session,
  // while session-tier users can control only Sessions they created.
  if (authorization.branchRbacEnabled) {
    const branch = await authorization.branchRepository.findById(session.branch_id);
    if (!branch) throw new NotFound(`Branch ${session.branch_id} not found`);
    const userId = decidedBy as UUID;
    const isOwner = await authorization.branchRepository.isOwner(branch.branch_id, userId);
    const branchPermission = await authorization.branchRepository.resolveUserPermission(
      branch,
      userId
    );
    const { allowed, effectiveLevel } = resolveSessionPromptAccess({
      branch,
      session,
      userId,
      isOwner,
      userRole: params.user?.role,
      allowSuperadmin: authorization.allowSuperadmin,
      branchPermission,
    });
    if (!allowed) {
      throw new Forbidden(
        `You have '${effectiveLevel}' permission on this branch, which does not allow ` +
          `responding to permission requests. Need 'prompt' or 'all' ` +
          `(or 'session' for your own sessions).`
      );
    }
  }

  // taskId is an untrusted lookup selector, never an authority. The selected
  // Message must independently bind the same Session + request id, and its
  // persisted task id is the only value used for delivery.
  const messagesService = app.service('messages') as ReturnType<Application['service']> & {
    findByTask(taskId: TaskID): Promise<Message[]>;
  };
  const messages = await messagesService.findByTask(data.taskId);
  const permissionMessage = messages.find((message) => {
    const content = message.content as PermissionRequestContent;
    return (
      message.session_id === sessionId &&
      message.type === 'permission_request' &&
      content?.request_id === data.requestId
    );
  });

  if (!permissionMessage) {
    throw new NotFound(`Permission request ${data.requestId} not found`);
  }

  const permissionContent = permissionMessage.content as PermissionRequestContent;
  if (permissionContent.status !== PermissionStatus.PENDING) {
    return {
      success: false,
      alreadyResolved: true,
      status: permissionContent.status,
      message: `Permission request already ${permissionContent.status}`,
    };
  }

  const taskId = permissionMessage.task_id;
  if (!taskId) {
    throw new BadRequest(
      'Cannot process permission decision: task_id is missing from the permission request'
    );
  }
  if (
    taskId !== data.taskId ||
    (permissionContent.task_id && permissionContent.task_id !== taskId)
  ) {
    throw new BadRequest('Permission request Task binding is inconsistent');
  }

  const { remember, scope } = normalizeScope(data);
  const delivery: PermissionDecisionDelivery = {
    requestId: data.requestId,
    taskId,
    sessionId,
    allow: data.allow,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    remember,
    scope,
    // Never trust the client-supplied audit identity.
    decidedBy,
  };

  emitServiceEvent(app, {
    path: 'messages',
    event: 'permission_resolved',
    data: delivery,
    id: permissionMessage.message_id,
    method: 'patch',
    params,
  });

  return { success: true };
}
