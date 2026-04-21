import type { AgorConfig } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import { CodexAuthStatusManager } from '../setup/codex-auth-status.js';

export class CodexAuthStatusService {
  constructor(private readonly manager: CodexAuthStatusManager) {}

  async get(_id: string, params?: AuthenticatedParams) {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    return this.manager.getStatusForUser(userId);
  }
}

export function createCodexAuthStatusService(
  db: Database,
  config: AgorConfig
): CodexAuthStatusService {
  return new CodexAuthStatusService(new CodexAuthStatusManager(db, config));
}
