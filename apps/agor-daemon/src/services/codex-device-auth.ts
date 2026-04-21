import type { AgorConfig } from '@agor/core/config';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import { CodexDeviceAuthManager } from '../setup/codex-device-auth.js';

export class CodexDeviceAuthService {
  constructor(
    private readonly config: AgorConfig,
    private readonly manager: CodexDeviceAuthManager
  ) {}

  async get(id: string, params?: AuthenticatedParams) {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const flow = this.manager.get(id);
    if (!flow) {
      return null;
    }
    if (flow.agorUserId !== userId) {
      throw new Forbidden("Cannot access another user's Codex auth flow");
    }

    return flow;
  }

  async create(_data: Record<string, never>, params?: AuthenticatedParams) {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    return this.manager.start(this.config, { agorUserId: userId });
  }

  async remove(id: string, params?: AuthenticatedParams) {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const flow = this.manager.get(id);
    if (!flow) {
      return null;
    }
    if (flow.agorUserId !== userId) {
      throw new Forbidden("Cannot cancel another user's Codex auth flow");
    }

    return this.manager.cancel(id);
  }
}

export function createCodexDeviceAuthService(config: AgorConfig): CodexDeviceAuthService {
  return new CodexDeviceAuthService(config, new CodexDeviceAuthManager());
}
