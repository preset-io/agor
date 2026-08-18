import { Forbidden } from '@agor/core/feathers';
import type { HookContext, Message, MessageID } from '@agor/core/types';
import { hasExecutorRuntimeScope } from '../auth/executor-runtime-scope.js';

export type PermissionMessageLoader = (messageId: MessageID) => Promise<Message | null>;

function declaresPermissionMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return (data as Record<string, unknown>).type === 'permission_request';
}

/** Reject public DTOs that attempt to mint executor-owned permission Messages. */
export function assertExternalPermissionMessageCreateAllowed(data: unknown): void {
  if (declaresPermissionMessage(data)) {
    throw new Forbidden('Permission messages can only be created by a task-scoped executor');
  }
}

/**
 * Keep permission request display and outcome fields owned by the verified
 * Task-scoped executor that is servicing the live provider callback.
 */
export function protectExternalPermissionMessageWrites(loadMessage: PermissionMessageLoader) {
  return async (context: HookContext): Promise<HookContext> => {
    if (!context.params.provider) return context;

    const executorScoped = hasExecutorRuntimeScope(context);
    if (context.method === 'create') {
      if (!executorScoped) assertExternalPermissionMessageCreateAllowed(context.data);
      return context;
    }

    if (context.method !== 'patch' && context.method !== 'remove') return context;
    if (context.id === null || context.id === undefined) return context;

    if (!executorScoped && context.method === 'patch' && declaresPermissionMessage(context.data)) {
      throw new Forbidden('Permission messages can only be changed by the task-scoped executor');
    }

    const message = await loadMessage(String(context.id) as MessageID);
    if (message?.type === 'permission_request' && !executorScoped) {
      throw new Forbidden('Permission messages can only be changed by the task-scoped executor');
    }
    return context;
  };
}
