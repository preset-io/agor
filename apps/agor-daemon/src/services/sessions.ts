/**
 * Sessions Service
 *
 * Provides REST + WebSocket API for session management.
 * Uses DrizzleService adapter with SessionRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, SessionRepository, type SessionWithLastMessage } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Paginated, QueryParams, Session, TaskID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Session service params
 */
export type SessionParams = QueryParams<{
  status?: Session['status'];
  agentic_tool?: Session['agentic_tool'];
  board_id?: string;
  include_last_message?: boolean | 'true' | 'false'; // Opt-in last message enrichment
  last_message_truncation_length?: number; // Default: 500 chars, min: 50, max: 10000
}>;

/**
 * Parse and validate last_message_truncation_length parameter
 * Feathers delivers query params as strings, so we need to parse and validate
 */
function parseTruncationLength(value: unknown): number {
  // Default value
  const DEFAULT = 500;
  const MIN = 50;
  const MAX = 10000;

  if (value === undefined || value === null) {
    return DEFAULT;
  }

  // Parse to number
  const parsed = typeof value === 'number' ? value : Number(value);

  // Validate: must be finite, positive, and within bounds
  if (!Number.isFinite(parsed) || parsed < MIN || parsed > MAX) {
    return DEFAULT;
  }

  return Math.floor(parsed); // Ensure integer
}

/**
 * Extended sessions service with custom methods
 */
export class SessionsService extends DrizzleService<Session, Partial<Session>, SessionParams> {
  private sessionRepo: SessionRepository;
  private app: Application;

  constructor(db: Database, app: Application) {
    const sessionRepo = new SessionRepository(db);
    super(sessionRepo, {
      id: 'session_id',
      resourceType: 'Session',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['patch', 'remove'], // Allow multi-patch and multi-remove
    });

    this.sessionRepo = sessionRepo;
    this.app = app;
  }

  /**
   * Custom method: Fork a session
   *
   * Creates a new session branching from the current session at a decision point.
   */
  async fork(
    id: string,
    data: { prompt: string; task_id?: string },
    params?: SessionParams
  ): Promise<Session> {
    const parent = await this.get(id, params);

    const forkedSession = await this.create(
      {
        agentic_tool: parent.agentic_tool,
        status: SessionStatus.IDLE,
        title: data.prompt.substring(0, 100), // First 100 chars as title
        description: data.prompt,
        worktree_id: parent.worktree_id,
        created_by: parent.created_by, // Inherit parent's creator for proper attribution
        unix_username: parent.unix_username, // Inherit parent's unix_username for consistent execution context
        git_state: { ...parent.git_state },
        genealogy: {
          forked_from_session_id: parent.session_id,
          fork_point_task_id: data.task_id as TaskID,
          fork_point_message_index: parent.message_count, // Capture parent's message count at fork time
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        tasks: [],
        message_count: 0,
        // Don't copy sdk_session_id - fork will get its own via forkSession:true
      },
      params
    );

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    // Cast forkedSession to Session to handle return type
    const session = forkedSession as Session;
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Spawn a child session
   *
   * Creates a new session for delegating a subsession to another agent.
   *
   * Settings inheritance:
   * - If spawning the same agentic tool → inherit parent's settings (permission_config, model_config)
   * - If spawning a different tool → use user's preferred settings for that tool
   * - Explicit overrides in SpawnConfig take precedence over both
   */
  async spawn(
    id: string,
    data: Partial<import('@agor/core/types').SpawnConfig>,
    params?: SessionParams
  ): Promise<Session> {
    // Validate required fields
    if (!data.prompt) {
      throw new Error('Spawn requires a prompt');
    }
    const parent = await this.get(id, params);
    const targetTool = data.agent || parent.agentic_tool;
    const isSameTool = targetTool === parent.agentic_tool;

    // Determine settings based on:
    // 1. Explicit overrides in SpawnConfig (highest priority)
    // 2. User preferences (if spawning different tool)
    // 3. Parent settings (fallback)

    let permissionConfig = parent.permission_config;
    let modelConfig = parent.model_config;

    // If spawning a different tool and no explicit overrides, fetch user preferences
    if (!isSameTool && !data.permissionMode && !data.modelConfig) {
      const userId = parent.created_by;
      if (userId && this.app) {
        try {
          const user = await this.app.service('users').get(userId, params);
          const toolDefaults = user?.default_agentic_config?.[targetTool];

          if (toolDefaults) {
            // Use user's preferred settings for this tool
            permissionConfig = {
              mode: toolDefaults.permissionMode,
              ...(targetTool === 'codex' &&
              toolDefaults.codexSandboxMode &&
              toolDefaults.codexApprovalPolicy
                ? {
                    codex: {
                      sandboxMode: toolDefaults.codexSandboxMode,
                      approvalPolicy: toolDefaults.codexApprovalPolicy,
                      networkAccess: toolDefaults.codexNetworkAccess,
                    },
                  }
                : {}),
            };

            if (toolDefaults.modelConfig) {
              modelConfig = {
                mode: toolDefaults.modelConfig.mode || 'alias',
                model: toolDefaults.modelConfig.model || '',
                updated_at: new Date().toISOString(),
                thinkingMode: toolDefaults.modelConfig.thinkingMode,
                manualThinkingTokens: toolDefaults.modelConfig.manualThinkingTokens,
              };
            }
          }
        } catch (error) {
          // If we can't fetch user preferences, fall back to parent settings
          console.warn(
            'Could not fetch user preferences for spawned session, using parent settings:',
            error
          );
        }
      }
    }

    // Apply explicit overrides from SpawnConfig
    if (data.permissionMode) {
      permissionConfig = {
        mode: data.permissionMode,
        ...(targetTool === 'codex' && data.codexSandboxMode && data.codexApprovalPolicy
          ? {
              codex: {
                sandboxMode: data.codexSandboxMode,
                approvalPolicy: data.codexApprovalPolicy,
                networkAccess: data.codexNetworkAccess,
              },
            }
          : permissionConfig?.codex
            ? { codex: permissionConfig.codex }
            : {}),
      };
    }

    if (data.modelConfig) {
      modelConfig = {
        mode: data.modelConfig.mode || 'alias',
        model: data.modelConfig.model || '',
        updated_at: new Date().toISOString(),
        thinkingMode: data.modelConfig.thinkingMode,
        manualThinkingTokens: data.modelConfig.manualThinkingTokens,
      };
    }

    // TODO: Handle MCP server attachment from data.mcpServerIds via session_mcp_servers junction table

    // Build callback configuration - only store explicit overrides
    // Leave fields undefined if not specified so parent's config applies
    const callbackConfig = {
      ...(data.enableCallback !== undefined ? { enabled: data.enableCallback } : {}),
      ...(data.includeLastMessage !== undefined
        ? { include_last_message: data.includeLastMessage }
        : {}),
      ...(data.includeOriginalPrompt !== undefined
        ? { include_original_prompt: data.includeOriginalPrompt }
        : {}),
    };

    // Build final prompt (append extra instructions if provided)
    let finalPrompt = data.prompt;
    if (data.extraInstructions) {
      finalPrompt = `${data.prompt}\n\n${data.extraInstructions}`;
    }

    const spawnedSession = await this.create(
      {
        agentic_tool: targetTool,
        status: SessionStatus.IDLE,
        title: data.title || data.prompt.substring(0, 100), // Use provided title or first 100 chars
        description: finalPrompt, // Use final prompt with extra instructions if provided
        worktree_id: parent.worktree_id,
        created_by: parent.created_by, // Inherit parent's creator for proper attribution
        unix_username: parent.unix_username, // Inherit parent's unix_username for consistent execution context
        git_state: { ...parent.git_state },
        genealogy: {
          parent_session_id: parent.session_id,
          spawn_point_task_id: data.task_id as TaskID,
          spawn_point_message_index: parent.message_count, // Capture parent's message count at spawn time
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        tasks: [],
        message_count: 0,
        permission_config: permissionConfig,
        model_config: modelConfig,
        callback_config: callbackConfig,
        // Don't copy sdk_session_id - spawn will get its own via forkSession:true
        // TODO: Handle MCP server attachment via session_mcp_servers junction table
      },
      params
    );

    // Cast spawnedSession to Session to handle return type (create returns Session | Session[])
    const session = spawnedSession as Session;

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Execute a prompt on this session
   *
   * Spawns an executor subprocess to run the prompt against the session.
   * The executor connects back to daemon via Feathers/WebSocket.
   *
   * NOTE: The actual implementation is provided by index.ts via setExecuteHandler
   */
  private executeHandler?: (
    sessionId: string,
    data: {
      prompt: string;
      permissionMode?: import('@agor/core/types').PermissionMode;
      stream?: boolean;
    },
    params?: SessionParams
  ) => Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }>;

  setExecuteHandler(
    handler: (
      sessionId: string,
      data: {
        prompt: string;
        permissionMode?: import('@agor/core/types').PermissionMode;
        stream?: boolean;
      },
      params?: SessionParams
    ) => Promise<{
      success: boolean;
      taskId: string;
      status: string;
      streaming: boolean;
    }>
  ): void {
    this.executeHandler = handler;
  }

  async executeTask(
    id: string,
    data: {
      prompt: string;
      permissionMode?: import('@agor/core/types').PermissionMode;
      stream?: boolean;
    },
    params?: SessionParams
  ): Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }> {
    if (this.executeHandler) {
      return this.executeHandler(id, data, params);
    }
    throw new Error('Execute handler not set - cannot execute task');
  }

  /**
   * Custom method: Stop a running task
   *
   * Emits a 'task_stop' event that the executor listens for via WebSocket.
   *
   * NOTE: The actual implementation is provided by index.ts via setStopHandler
   */
  private stopHandler?: (
    sessionId: string,
    data: { taskId: string },
    params?: SessionParams
  ) => Promise<{ success: boolean; message: string }>;

  setStopHandler(
    handler: (
      sessionId: string,
      data: { taskId: string },
      params?: SessionParams
    ) => Promise<{ success: boolean; message: string }>
  ): void {
    this.stopHandler = handler;
  }

  async stopTask(
    id: string,
    data: { taskId: string },
    params?: SessionParams
  ): Promise<{ success: boolean; message: string }> {
    if (this.stopHandler) {
      return this.stopHandler(id, data, params);
    }
    throw new Error('Stop handler not set - cannot stop task');
  }

  /**
   * Custom method: Trigger queue processing
   *
   * Processes the next queued message for an idle session.
   * Used by callback system to trigger immediate queue processing.
   *
   * NOTE: The actual implementation is provided by index.ts via setQueueProcessor
   */
  private queueProcessor?: (sessionId: string, params?: SessionParams) => Promise<void>;

  setQueueProcessor(processor: (sessionId: string, params?: SessionParams) => Promise<void>): void {
    this.queueProcessor = processor;
  }

  async triggerQueueProcessing(id: string, params?: SessionParams): Promise<void> {
    if (this.queueProcessor) {
      await this.queueProcessor(id, params);
    } else {
      console.warn('⚠️  [SessionsService] Queue processor not set, cannot trigger queue processing');
    }
  }

  /**
   * Custom method: Get session genealogy tree
   *
   * Returns ancestors and descendants for visualization.
   */
  async getGenealogy(
    id: string,
    params?: SessionParams
  ): Promise<{
    session: Session;
    ancestors: Session[];
    children: Session[];
  }> {
    const session = await this.get(id, params);

    // Get ancestors
    const ancestors = await this.sessionRepo.findAncestors(id);

    // Get children
    const children = await this.sessionRepo.findChildren(id);

    return {
      session,
      ancestors,
      children,
    };
  }

  /**
   * Override remove to cascade delete children (forks and subsessions)
   */
  async remove(
    id: import('@agor/core/types').NullableId,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    // Handle batch delete
    if (id === null) {
      // For multi-delete, get all matching sessions and delete each one
      const sessions = (await super.find(params)) as Session[];
      const results: Session[] = [];

      for (const session of sessions) {
        const deleted = (await this.remove(session.session_id, params)) as Session;
        results.push(deleted);
      }

      return results;
    }

    // Single delete with cascade
    // Get the session before deleting
    const session = await this.get(String(id), params);

    // Find all children (forks and subsessions)
    const children = await this.sessionRepo.findChildren(String(id));

    // Recursively delete all children first
    if (children.length > 0) {
      for (const child of children) {
        await this.remove(child.session_id, params);
      }
    }

    // Now delete the current session (messages and tasks are cascade-deleted by DB)
    await this.sessionRepo.delete(id as string);

    // Emit removed event for WebSocket broadcasting
    this.emit?.('removed', session, params);

    return session;
  }

  /**
   * Override get to optionally enrich with last message
   *
   * Last message enrichment is opt-in via include_last_message query parameter
   */
  async get(id: string, params?: SessionParams): Promise<SessionWithLastMessage> {
    // Check both query params and root-level params (root-level bypasses Feathers query filtering)
    const includeLastMessageQuery = params?.query?.include_last_message;
    // biome-ignore lint/suspicious/noExplicitAny: Custom params bypass Feathers type system
    const includeLastMessageRoot = (params as any)?._include_last_message;
    const includeLastMessage = includeLastMessageRoot ?? includeLastMessageQuery;

    const session = await super.get(id, params);

    // Only enrich with last message if explicitly requested
    if (includeLastMessage === true || includeLastMessage === 'true') {
      const truncationLengthQuery = params?.query?.last_message_truncation_length;
      // biome-ignore lint/suspicious/noExplicitAny: Custom params bypass Feathers type system
      const truncationLengthRoot = (params as any)?._last_message_truncation_length;
      const truncationLength = parseTruncationLength(truncationLengthRoot ?? truncationLengthQuery);
      const result = await this.sessionRepo.enrichWithLastMessage(
        session as Session,
        truncationLength
      );
      return result;
    }

    return session as SessionWithLastMessage;
  }

  /**
   * Override find - no custom logic, just use default find
   *
   * Note: Last message is NOT included in list operations - only on single GET
   */
  async find(params?: SessionParams): Promise<Paginated<Session> | Session[]> {
    // Use default find to ensure all hooks and scoping are applied
    return super.find(params);
  }
}

/**
 * Service factory function
 */
export function createSessionsService(db: Database, app: Application): SessionsService {
  return new SessionsService(db, app);
}
