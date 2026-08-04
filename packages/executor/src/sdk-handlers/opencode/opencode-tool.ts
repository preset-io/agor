import {
  OpenCodeTool as OpenCodeRuntime,
  type OpenCodeToolDependencies as OpenCodeRuntimeDependencies,
  resolvePackagedOpenCodeBinary,
} from '@agor/agentic-tool-opencode/runtime';
import type { SessionID } from '@agor/core/types';
import { getDaemonUrl } from '../../config.js';
import type {
  MCPOAuthAuthHeadersRepository,
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import { enrichContentBlocks } from '../base/diff-enrichment.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import { createCanUseToolCallback } from '../base/permission-hooks.js';

export {
  isOpenCodeCleanupUnverifiedError,
  type OpenCodeCanUseToolCallback,
  OpenCodeCleanupUnverifiedError,
  OpenCodeInteractionTimeoutError,
  type OpenCodeInvocationConfig,
  OpenCodePermissionRejectedError,
  type OpenCodeStreamingCallbacks,
  type OpenCodeTurnResult,
  type RunOpenCodeTurnInput,
} from '@agor/agentic-tool-opencode/runtime';
export { resolvePackagedOpenCodeBinary };

export type OpenCodeToolDependencies = OpenCodeRuntimeDependencies & {
  sessionMCPRepo?: SessionMCPServerRepository;
  mcpServerRepo?: MCPServerRepository;
  mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository;
  permissionService?: PermissionService;
  messagesRepo?: MessagesRepository;
  messagesService?: MessagesService;
  tasksService?: TasksService;
  sessionsService?: SessionsPatchClient;
};

/**
 * Executor composition adapter. Host repositories, permissions, and daemon
 * addressing enter through ports; OpenCode protocol behavior stays packaged.
 */
export class OpenCodeTool extends OpenCodeRuntime {
  constructor(dependencies: OpenCodeToolDependencies) {
    const {
      sessionMCPRepo,
      mcpServerRepo,
      mcpOAuthAuthHeadersRepo,
      permissionService,
      messagesRepo,
      messagesService,
      tasksService,
      sessionsService,
    } = dependencies;
    const permissionLocks = new Map<SessionID, Promise<void>>();

    super({
      ...dependencies,
      getDaemonUrl: dependencies.getDaemonUrl ?? getDaemonUrl,
      resolveMcpServers:
        dependencies.resolveMcpServers ??
        (async (sessionId) => {
          if (!sessionMCPRepo || !mcpServerRepo) {
            throw new Error('OpenCode requires MCP repository dependencies');
          }
          return getMcpServersForSession(sessionId, {
            mode: 'strict',
            sessionMCPRepo,
            mcpServerRepo,
            mcpOAuthAuthHeadersRepo,
          });
        }),
      createPermissionCallback:
        dependencies.createPermissionCallback ??
        ((sessionId, taskId) => {
          if (
            !permissionService ||
            !messagesRepo ||
            !messagesService ||
            !tasksService ||
            !sessionsService ||
            !sessionMCPRepo ||
            !mcpServerRepo
          ) {
            return undefined;
          }
          return createCanUseToolCallback(sessionId, taskId, {
            permissionService,
            tasksService,
            messagesRepo,
            messagesService,
            sessionsService,
            permissionLocks,
            mcpServerRepo,
            sessionMCPRepo,
            deferTerminalState: true,
          });
        }),
      cancelPendingPermissions:
        dependencies.cancelPendingPermissions ??
        ((sessionId) => permissionService?.cancelPendingRequests(sessionId)),
      enrichContentBlocks: dependencies.enrichContentBlocks ?? enrichContentBlocks,
    });
  }
}
