import { type ApiKeyName, resolveApiKey } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, TaskID, UserID } from '@agor/core/types';

interface TaskRecord {
  created_by?: UserID | null;
}

interface TaskLookupService {
  get(id: TaskID, params?: { provider?: undefined }): Promise<TaskRecord | null>;
}

function isNotFoundError(error: unknown): boolean {
  const maybeError = error as { name?: string; code?: number; className?: string };
  return (
    maybeError?.name === 'NotFound' ||
    maybeError?.className === 'not-found' ||
    maybeError?.code === 404
  );
}

export interface ResolveApiKeyResponse {
  apiKey: string | null;
  source: 'user' | 'config' | 'env' | 'native';
  useNativeAuth: boolean;
  decryptionFailed?: boolean;
}

export class ConfigResolveApiKeyService {
  constructor(
    private readonly db: Database,
    private readonly tasksService: TaskLookupService
  ) {}

  async create(
    data: { taskId?: TaskID; keyName?: string },
    params?: AuthenticatedParams
  ): Promise<ResolveApiKeyResponse> {
    const user = params?.user;
    if (!user) {
      throw new NotAuthenticated('Authentication required');
    }

    const taskId = data.taskId;
    if (!taskId) {
      throw new BadRequest('taskId is required');
    }

    const keyName = data.keyName?.trim() as ApiKeyName | undefined;
    if (!keyName) {
      throw new BadRequest('keyName is required');
    }

    let task: TaskRecord | null;
    try {
      task = await this.tasksService.get(taskId, { provider: undefined });
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new Forbidden('Cannot resolve API key for this task');
      }
      throw error;
    }

    const taskOwnerId = task?.created_by ?? undefined;
    if (!taskOwnerId) {
      throw new Forbidden('Cannot resolve API key for this task');
    }

    if (!user._isServiceAccount && taskOwnerId !== user.user_id) {
      throw new Forbidden("Cannot resolve API key for another user's task");
    }

    const result = await resolveApiKey(keyName, {
      userId: taskOwnerId,
      db: this.db,
    });

    return {
      apiKey: result.apiKey ?? null,
      source: result.source === 'none' ? 'native' : result.source,
      useNativeAuth: result.useNativeAuth,
      ...(result.decryptionFailed && { decryptionFailed: true }),
    };
  }
}
