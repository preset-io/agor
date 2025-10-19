/**
 * Claude Prompt Service
 *
 * Handles live execution of prompts against Claude sessions using Claude Agent SDK.
 * Automatically loads CLAUDE.md and uses preset system prompts matching Claude Code CLI.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookJSONOutput,
  PermissionMode,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk/sdkTypes';
import { generateId } from '../../db/ids';
import type { MCPServerRepository } from '../../db/repositories/mcp-servers';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { PermissionService } from '../../permissions/permission-service';
import type { MCPServersConfig, SessionID, TaskID } from '../../types';
import type { SessionsService, TasksService } from './claude-tool';
import { DEFAULT_CLAUDE_MODEL } from './models';

/**
 * Get path to Claude Code executable
 * Uses `which claude` to find it in PATH
 */
function getClaudeCodePath(): string {
  try {
    const path = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (path) return path;
  } catch {
    // which failed, try common paths
  }

  // Fallback to common installation paths
  const commonPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.nvm/versions/node/v20.19.4/bin/claude`,
  ];

  for (const path of commonPaths) {
    try {
      execSync(`test -x "${path}"`, { encoding: 'utf-8' });
      return path;
    } catch {}
  }

  throw new Error(
    'Claude Code executable not found. Install with: npm install -g @anthropic-ai/claude-code'
  );
}

export interface PromptResult {
  /** Assistant messages (can be multiple: tool invocation, then response) */
  messages: Array<{
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    toolUses?: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
  }>;
  /** Number of input tokens */
  inputTokens: number;
  /** Number of output tokens */
  outputTokens: number;
}

export class ClaudePromptService {
  /** Enable token-level streaming from Claude Agent SDK */
  private static readonly ENABLE_TOKEN_STREAMING = true;

  /** Store active Query objects per session for interruption */
  // biome-ignore lint/suspicious/noExplicitAny: Query type from SDK is complex
  private activeQueries = new Map<SessionID, any>();

  /** Track stop requests for immediate loop breaking */
  private stopRequested = new Map<SessionID, boolean>();

  constructor(
    _messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private apiKey?: string,
    private sessionMCPRepo?: SessionMCPServerRepository,
    private mcpServerRepo?: MCPServerRepository,
    private permissionService?: PermissionService,
    private tasksService?: TasksService,
    private sessionsService?: SessionsService // FeathersJS Sessions service for WebSocket broadcasting
  ) {
    // No client initialization needed - Agent SDK is stateless
  }

  /**
   * Create PreToolUse hook for permission handling
   * @private
   */
  private createPreToolUseHook(sessionId: SessionID, taskId: TaskID) {
    return async (
      input: PreToolUseHookInput,
      toolUseID: string | undefined,
      options: { signal: AbortSignal }
    ): Promise<HookJSONOutput> => {
      // If no permission service or tasks service, allow by default
      if (!this.permissionService || !this.tasksService) {
        return {};
      }

      try {
        // Check session-specific permission overrides first
        // IMPORTANT: Always fetch fresh session data to catch recently saved permissions
        const session = await this.sessionsRepo.findById(sessionId);

        if (session?.permission_config?.allowedTools?.includes(input.tool_name)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: 'Allowed by session config',
            },
          };
        }

        // Generate request ID
        const requestId = generateId();
        const timestamp = new Date().toISOString();

        // Update task status to 'awaiting_permission' via FeathersJS service (emits WebSocket)
        await this.tasksService.patch(taskId, {
          status: 'awaiting_permission',
          permission_request: {
            request_id: requestId,
            tool_name: input.tool_name,
            tool_input: input.tool_input as Record<string, unknown>,
            tool_use_id: toolUseID,
            requested_at: timestamp,
          },
        });

        // Emit WebSocket event for UI (broadcasts to ALL viewers)
        this.permissionService.emitRequest(sessionId, {
          requestId,
          taskId,
          toolName: input.tool_name,
          toolInput: input.tool_input as Record<string, unknown>,
          toolUseID,
          timestamp,
        });

        // Wait for UI decision (Promise pauses SDK execution)
        const decision = await this.permissionService.waitForDecision(
          requestId,
          taskId,
          options.signal
        );

        // Update task with approval info and resume status via FeathersJS service
        // IMPORTANT: Must send full permission_request object, not dot notation
        // Dot notation works in DB but doesn't broadcast properly via WebSocket
        const currentTask = await this.tasksService.get(taskId);
        await this.tasksService.patch(taskId, {
          status: decision.allow ? 'running' : 'failed',
          permission_request: {
            ...currentTask.permission_request,
            approved_by: decision.decidedBy,
            approved_at: new Date().toISOString(),
          },
        });

        // Persist decision if user clicked "Remember"
        if (decision.remember) {
          // RE-FETCH session to get latest data (avoid stale closure)
          const freshSession = await this.sessionsRepo.findById(sessionId);
          if (!freshSession) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: decision.allow ? 'allow' : 'deny',
                permissionDecisionReason: decision.reason,
              },
            };
          }

          if (decision.scope === 'session') {
            // Update session-level permissions via FeathersJS service (broadcasts WebSocket events)
            const currentAllowed = freshSession.permission_config?.allowedTools || [];

            // IMPORTANT: Use FeathersJS service (if available) for WebSocket broadcasting
            // Fall back to repository if service not available (e.g., in tests)
            const newAllowedTools = [...currentAllowed, input.tool_name];
            const updateData = {
              permission_config: {
                allowedTools: newAllowedTools,
              },
            };

            if (this.sessionsService) {
              await this.sessionsService.patch(sessionId, updateData);
            } else {
              await this.sessionsRepo.update(sessionId, updateData);
            }
          } else if (decision.scope === 'project') {
            // Update project-level permissions in .claude/settings.json
            await this.updateProjectSettings(freshSession.repo.cwd, {
              allowTools: [input.tool_name],
            });
          }
        }

        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.allow ? 'allow' : 'deny',
            permissionDecisionReason: decision.reason,
          },
        };
      } catch (error) {
        // On any error in the permission flow, mark task as failed
        console.error('PreToolUse hook error:', error);

        try {
          await this.tasksService.patch(taskId, {
            status: 'failed',
            report: {
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            },
          });
        } catch (updateError) {
          console.error('Failed to update task status:', updateError);
        }

        // Return deny to SDK so tool doesn't execute
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Permission hook failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    };
  }

  /**
   * Update project-level permissions in .claude/settings.json
   * @private
   */
  private async updateProjectSettings(
    cwd: string,
    changes: {
      allowTools?: string[];
      denyTools?: string[];
    }
  ) {
    const settingsPath = path.join(cwd, '.claude', 'settings.json');

    // Read existing settings or create default structure
    // biome-ignore lint/suspicious/noExplicitAny: Settings JSON structure is dynamic
    let settings: any = {};
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      // File doesn't exist, create default structure
      settings = { permissions: { allow: { tools: [] } } };
    }

    // Ensure permissions structure exists
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = {};
    if (!settings.permissions.allow.tools) settings.permissions.allow.tools = [];

    // Apply changes
    if (changes.allowTools) {
      settings.permissions.allow.tools = [
        ...new Set([...settings.permissions.allow.tools, ...changes.allowTools]),
      ];
    }
    if (changes.denyTools) {
      if (!settings.permissions.deny) settings.permissions.deny = [];
      settings.permissions.deny = [
        ...new Set([...settings.permissions.deny, ...changes.denyTools]),
      ];
    }

    // Ensure .claude directory exists
    const claudeDir = path.join(cwd, '.claude');
    try {
      await fs.mkdir(claudeDir, { recursive: true });
    } catch {}

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  /**
   * Load session and initialize query
   * @private
   */
  private async setupQuery(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    resume = true
  ): Promise<{
    // biome-ignore lint/suspicious/noExplicitAny: SDK Message types include user, assistant, stream_event, result, etc.
    query: AsyncGenerator<any, any, unknown>;
    resolvedModel: string;
  }> {
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Determine model to use (session config or default)
    const modelConfig = session.model_config;
    const model = modelConfig?.model || DEFAULT_CLAUDE_MODEL;

    // Validate CWD exists
    const cwd = session.repo?.cwd || process.cwd();
    if (!session.repo?.cwd) {
      console.warn(`Session ${sessionId} has no repo.cwd, using process.cwd(): ${cwd}`);
    }

    this.logPromptStart(sessionId, prompt, cwd, resume ? session.sdk_session_id : undefined);

    // Get Claude Code path
    const claudeCodePath = getClaudeCodePath();

    const options: Record<string, unknown> = {
      cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project'], // Load user + project permissions, auto-loads CLAUDE.md
      model, // Use configured model or default
      pathToClaudeCodeExecutable: claudeCodePath,
      // Allow access to common directories outside CWD (e.g., /tmp)
      additionalDirectories: ['/tmp', '/var/tmp'],
      // Enable token-level streaming (yields partial messages as tokens arrive)
      includePartialMessages: ClaudePromptService.ENABLE_TOKEN_STREAMING,
      // Enable debug logging to see what's happening
      debug: true,
    };

    // Add permissionMode if provided
    // For Claude Code sessions, the UI should pass Claude SDK permission modes directly:
    // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    // No mapping needed - UI is responsible for showing correct options per agent type
    if (permissionMode) {
      options.permissionMode = permissionMode;
    }

    // Add session-level allowed tools from our database
    const sessionAllowedTools = session.permission_config?.allowedTools || [];
    if (sessionAllowedTools.length > 0) {
      options.allowedTools = sessionAllowedTools;
    }

    // Add PreToolUse hook if permission service is available and taskId provided
    // This enables Agor's custom permission UI (WebSocket-based) instead of CLI prompts
    if (this.permissionService && taskId) {
      options.hooks = {
        PreToolUse: [
          {
            hooks: [this.createPreToolUseHook(sessionId, taskId)],
          },
        ],
      };
    }

    // Add optional apiKey if provided
    if (this.apiKey || process.env.ANTHROPIC_API_KEY) {
      options.apiKey = this.apiKey || process.env.ANTHROPIC_API_KEY;
    }

    // Add optional resume if session exists
    if (resume && session.sdk_session_id) {
      options.resume = session.sdk_session_id;
    }

    // Fetch and configure MCP servers for this session (hierarchical scoping)
    // NOTE: Currently disabled for testing session resumption
    // biome-ignore lint/correctness/noConstantCondition: Temporarily disabled for testing
    if (false && this.sessionMCPRepo && this.mcpServerRepo) {
      try {
        const allServers: Array<{
          // biome-ignore lint/suspicious/noExplicitAny: MCPServer type from multiple sources
          server: any;
          source: string;
        }> = [];

        // 1. Global servers (always included)
        console.log('🔌 Fetching MCP servers with hierarchical scoping...');
        const globalServers = await this.mcpServerRepo.findAll({
          scope: 'global',
          enabled: true,
        });
        console.log(`   📍 Global scope: ${globalServers.length} server(s)`);
        for (const server of globalServers) {
          allServers.push({ server, source: 'global' });
        }

        // 2. Repo-scoped servers (if session has a repo)
        if (session.repo?.repo_id) {
          const repoServers = await this.mcpServerRepo.findAll({
            scope: 'repo',
            scopeId: session.repo.repo_id,
            enabled: true,
          });
          console.log(`   📍 Repo scope: ${repoServers.length} server(s)`);
          for (const server of repoServers) {
            allServers.push({ server, source: 'repo' });
          }
        }

        // 3. Team-scoped servers (if session has a team - future feature)
        // if (session.team_id) {
        //   const teamServers = await this.mcpServerRepo.findAll({
        //     scope: 'team',
        //     scopeId: session.team_id,
        //     enabled: true,
        //   });
        //   console.log(`   📍 Team scope: ${teamServers.length} server(s)`);
        //   for (const server of teamServers) {
        //     allServers.push({ server, source: 'team' });
        //   }
        // }

        // 4. Session-specific servers (from join table)
        const sessionServers = await this.sessionMCPRepo.listServers(sessionId, true); // enabledOnly
        console.log(`   📍 Session scope: ${sessionServers.length} server(s)`);
        for (const server of sessionServers) {
          allServers.push({ server, source: 'session' });
        }

        // 5. Deduplicate by server ID (later scopes override earlier ones)
        // This means: session > team > repo > global
        const serverMap = new Map<
          string,
          {
            // biome-ignore lint/suspicious/noExplicitAny: MCPServer type from multiple sources
            server: any;
            source: string;
          }
        >();
        for (const item of allServers) {
          serverMap.set(item.server.mcp_server_id, item);
        }
        const uniqueServers = Array.from(serverMap.values());

        console.log(
          `   ✅ Total: ${uniqueServers.length} unique MCP server(s) after deduplication`
        );

        if (uniqueServers.length > 0) {
          // Convert to SDK format
          const mcpConfig: MCPServersConfig = {};
          const allowedTools: string[] = [];

          for (const { server, source } of uniqueServers) {
            console.log(`   - ${server.name} (${server.transport}) [${source}]`);

            // Build server config
            const serverConfig: {
              transport?: 'stdio' | 'http' | 'sse';
              command?: string;
              args?: string[];
              url?: string;
              env?: Record<string, string>;
            } = {
              transport: server.transport,
            };

            if (server.command) serverConfig.command = server.command;
            if (server.args) serverConfig.args = server.args;
            if (server.url) serverConfig.url = server.url;
            if (server.env) serverConfig.env = server.env;

            mcpConfig[server.name] = serverConfig;

            // Add tools to allowlist
            if (server.tools) {
              for (const tool of server.tools) {
                allowedTools.push(tool.name);
              }
            }
          }

          options.mcpServers = mcpConfig;
          console.log(`   🔧 MCP config being passed to SDK:`, JSON.stringify(mcpConfig, null, 2));
          if (allowedTools.length > 0) {
            options.allowedTools = allowedTools;
            console.log(`   🔧 Allowing ${allowedTools.length} MCP tools`);
          }
        }
      } catch (error) {
        console.warn('⚠️  Failed to fetch MCP servers for session:', error);
        // Continue without MCP servers - non-fatal error
      }
    }

    console.log('📤 Calling query() with:');
    console.log(`   prompt: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
    console.log(`   options keys: ${Object.keys(options).join(', ')}`);
    console.log(
      `   Full query call:`,
      JSON.stringify(
        {
          prompt,
          options,
        },
        null,
        2
      )
    );

    const result = query({
      prompt,
      // biome-ignore lint/suspicious/noExplicitAny: SDK Options type doesn't include all available fields
      options: options as any,
    });

    // Store query object for potential interruption (Claude SDK has native interrupt() method)
    this.activeQueries.set(sessionId, result);

    return { query: result, resolvedModel: model };
  }

  /**
   * Log prompt start with context
   * @private
   */
  private logPromptStart(
    sessionId: SessionID,
    prompt: string,
    cwd: string,
    agentSessionId?: string
  ) {
    console.log(`🤖 Prompting Claude for session ${sessionId.substring(0, 8)}...`);
    if (agentSessionId) {
      console.log(`   Resuming session: ${agentSessionId}`);
    }
  }

  /**
   * Process content from assistant message into content blocks
   * @private
   */
  private processContentBlocks(
    content: unknown,
    messageNum: number
  ): Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }> {
    const contentBlocks: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }> = [];

    if (typeof content === 'string') {
      contentBlocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        contentBlocks.push(block);
      }
    }

    return contentBlocks;
  }

  /**
   * Extract tool uses from content blocks
   * @private
   */
  private extractToolUses(
    contentBlocks: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>
  ): Array<{ id: string; name: string; input: Record<string, unknown> }> {
    return contentBlocks
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        id: block.id!,
        name: block.name!,
        input: block.input || {},
      }));
  }

  /**
   * Prompt a session using Claude Agent SDK (streaming version with text chunking)
   *
   * Yields both complete assistant messages AND text chunks as they're generated.
   * This enables real-time typewriter effect in the UI.
   *
   * @param sessionId - Session to prompt
   * @param prompt - User prompt
   * @param taskId - Optional task ID for permission tracking
   * @param permissionMode - Optional permission mode for SDK
   * @param chunkCallback - Optional callback for text chunks (3-10 words)
   * @returns Async generator yielding assistant messages with SDK session ID
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    _chunkCallback?: (messageId: string, chunk: string) => void
  ): AsyncGenerator<{
    type: 'partial' | 'complete';
    textChunk?: string; // For partial streaming events
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    agentSessionId?: string;
    resolvedModel?: string;
  }> {
    const { query: result, resolvedModel } = await this.setupQuery(
      sessionId,
      prompt,
      taskId,
      permissionMode,
      true
    );

    // Collect and yield assistant messages progressively
    let messageCount = 0;
    let capturedAgentSessionId: string | undefined;

    for await (const msg of result) {
      messageCount++;

      // Check if stop was requested (for immediate loop breaking)
      if (this.stopRequested.get(sessionId)) {
        console.log(
          `🛑 Stop requested for session ${sessionId.substring(0, 8)}, breaking event loop`
        );
        this.stopRequested.delete(sessionId);
        break;
      }

      // Capture SDK session_id from first message that has it
      if (!capturedAgentSessionId && 'session_id' in msg && msg.session_id) {
        capturedAgentSessionId = msg.session_id;
      }

      // Handle partial streaming events (token-level streaming)
      if (msg.type === 'stream_event' && ClaudePromptService.ENABLE_TOKEN_STREAMING) {
        // biome-ignore lint/suspicious/noExplicitAny: SDK event structure is complex
        const event = (msg as any).event;

        // Extract text from content_block_delta events
        if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
          const textChunk = event.delta.text;

          // Yield partial chunk immediately (enables real-time streaming)
          yield {
            type: 'partial',
            textChunk,
            agentSessionId: capturedAgentSessionId,
            resolvedModel,
          };
        }
      }
      // Handle complete assistant messages
      else if (msg.type === 'assistant') {
        const contentBlocks = this.processContentBlocks(msg.message?.content, messageCount);
        const toolUses = this.extractToolUses(contentBlocks);

        // Yield complete message for database storage
        yield {
          type: 'complete',
          content: contentBlocks,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
          agentSessionId: capturedAgentSessionId,
          resolvedModel,
        };
      }
    }

    // Clean up query reference
    this.activeQueries.delete(sessionId);
  }

  /**
   * Prompt a session using Claude Agent SDK (non-streaming version)
   *
   * The Agent SDK automatically:
   * - Loads CLAUDE.md from the working directory
   * - Uses Claude Code preset system prompt
   * - Handles streaming via async generators
   *
   * @param sessionId - Session to prompt
   * @param prompt - User prompt
   * @returns Complete assistant response with metadata
   */
  async promptSession(sessionId: SessionID, prompt: string): Promise<PromptResult> {
    const { query: result } = await this.setupQuery(sessionId, prompt, undefined, undefined, false);

    // Collect response messages from async generator
    // IMPORTANT: Keep assistant messages SEPARATE (don't merge into one)
    const assistantMessages: Array<{
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    }> = [];
    let messageCount = 0;

    for await (const msg of result) {
      messageCount++;

      if (msg.type === 'assistant') {
        const contentBlocks = this.processContentBlocks(msg.message?.content, messageCount);
        const toolUses = this.extractToolUses(contentBlocks);

        // Add as separate assistant message
        assistantMessages.push({
          content: contentBlocks,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
        });
      }
    }

    // Clean up query reference
    this.activeQueries.delete(sessionId);

    // TODO: Extract token counts from Agent SDK result metadata
    return {
      messages: assistantMessages,
      inputTokens: 0, // Agent SDK doesn't expose this yet
      outputTokens: 0,
    };
  }

  /**
   * Stop currently executing task
   *
   * Uses Claude Agent SDK's native interrupt() method to gracefully stop execution.
   * This is the same mechanism used by the Escape key in Claude Code CLI.
   *
   * @param sessionId - Session identifier
   * @returns Success status
   */
  async stopTask(sessionId: SessionID): Promise<{ success: boolean; reason?: string }> {
    console.log(`🛑 Stopping task for session ${sessionId.substring(0, 8)}`);

    const queryObj = this.activeQueries.get(sessionId);

    if (!queryObj) {
      return {
        success: false,
        reason: 'No active task found for this session',
      };
    }

    try {
      // Set stop flag first for immediate loop breaking
      this.stopRequested.set(sessionId, true);

      // Call native interrupt() method on Query object
      // This is exactly what the Escape key uses in Claude Code CLI
      await queryObj.interrupt();

      // Clean up query reference
      this.activeQueries.delete(sessionId);

      console.log(`✅ Stopped Claude execution for session ${sessionId.substring(0, 8)}`);
      return { success: true };
    } catch (error) {
      console.error('Failed to interrupt Claude execution:', error);
      // Clean up stop flag on error
      this.stopRequested.delete(sessionId);
      return {
        success: false,
        reason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
