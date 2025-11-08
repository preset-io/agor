/**
 * Codex Prompt Service
 *
 * Handles live execution of prompts against Codex sessions using OpenAI Codex SDK.
 * Wraps the @openai/codex-sdk for thread management and execution.
 *
 * IMPORTANT: This service caches the Codex SDK instance and only recreates it when
 * the API key or MCP server configuration actually changes. This prevents a memory leak
 * where new Codex CLI processes would be spawned on every prompt execution without cleanup.
 * See issue #133 for details.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Codex, type Thread, type ThreadItem } from '@openai/codex-sdk';
import { getCredential, resolveApiKey, resolveUserEnvironment } from '../../config';
import type { Database } from '../../db/client';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { WorktreeRepository } from '../../db/repositories/worktrees';
import type { PermissionMode, SessionID, TaskID } from '../../types';
import { DEFAULT_CODEX_MODEL } from './models';

export interface CodexPromptResult {
  /** Complete assistant response from Codex */
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
  /** Agent SDK thread ID for conversation continuity */
  threadId: string;
}

/**
 * Streaming event types for Codex execution
 */
export type CodexStreamEvent =
  | {
      type: 'partial';
      textChunk: string;
      threadId?: string;
      resolvedModel?: string;
    }
  | {
      type: 'tool_start';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      };
      threadId?: string;
    }
  | {
      type: 'tool_complete';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        output?: string;
        status?: string;
      };
      threadId?: string;
    }
  | {
      type: 'complete';
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
      threadId: string;
      resolvedModel?: string;
    };

export class CodexPromptService {
  private codex: Codex;
  private lastMCPServersHash: string | null = null;
  private lastApiKey: string | null = null;
  private stopRequested = new Map<SessionID, boolean>();
  private apiKey: string | undefined;
  private db?: Database;

  constructor(
    _messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private sessionMCPServerRepo?: SessionMCPServerRepository,
    private worktreesRepo?: WorktreeRepository,
    apiKey?: string,
    db?: Database
  ) {
    // Store API key for reinitializing SDK
    this.apiKey = apiKey;
    this.db = db;
    const initialApiKey = apiKey || process.env.OPENAI_API_KEY || '';
    this.lastApiKey = initialApiKey;
    // Initialize Codex SDK
    this.codex = new Codex({
      apiKey: initialApiKey,
    });
  }

  /**
   * Reinitialize Codex SDK to pick up config changes
   * Call this after updating ~/.codex/config.toml
   *
   * NOTE: This is only called when MCP server config changes, which requires
   * a full SDK restart to pick up the new config.toml file
   */
  private reinitializeCodex(): void {
    console.log('🔄 [Codex] Reinitializing SDK to pick up config changes...');
    const apiKey = this.apiKey || process.env.OPENAI_API_KEY || '';
    this.codex = new Codex({
      apiKey,
    });
    this.lastApiKey = apiKey;
    console.log('✅ [Codex] SDK reinitialized');
  }

  /**
   * Refresh Codex client with latest API key from config
   * Ensures hot-reload of credentials from Settings UI
   *
   * IMPORTANT: Only recreates Codex instance if API key actually changed
   * This prevents memory leak from spawning multiple Codex CLI processes
   */
  private refreshClient(currentApiKey: string): void {
    // Only recreate if API key changed (prevents memory leak - issue #133)
    if (this.lastApiKey !== currentApiKey) {
      console.log('🔄 [Codex] API key changed, reinitializing SDK...');
      this.codex = new Codex({
        apiKey: currentApiKey,
      });
      this.lastApiKey = currentApiKey;
      console.log('✅ [Codex] SDK reinitialized with new API key');
    }
  }

  /**
   * Generate ~/.codex/config.toml with approval_policy, network_access, and MCP servers
   *
   * NOTE: approval_policy, network_access, and MCP servers must be configured via config.toml
   * (not available in ThreadOptions). We minimize file writes by tracking a hash
   * of the configuration and only updating when it changes.
   *
   * @param approvalPolicy - Codex approval policy (untrusted, on-request, on-failure, never)
   * @param networkAccess - Whether to allow outbound network access in workspace-write mode
   * @param sessionId - Session ID for fetching MCP servers
   * @returns Number of MCP servers configured
   */
  private async ensureCodexConfig(
    approvalPolicy: 'untrusted' | 'on-request' | 'on-failure' | 'never',
    networkAccess: boolean,
    sessionId: SessionID
  ): Promise<number> {
    // Fetch MCP servers for this session (if repository is available)
    console.log(`🔍 [Codex MCP] Fetching MCP servers for session ${sessionId.substring(0, 8)}...`);
    if (!this.sessionMCPServerRepo) {
      console.warn('⚠️  [Codex MCP] SessionMCPServerRepository not available!');
    }
    const mcpServers = this.sessionMCPServerRepo
      ? await this.sessionMCPServerRepo.listServers(sessionId, true) // enabledOnly = true
      : [];

    console.log(`📊 [Codex MCP] Found ${mcpServers.length} MCP server(s) for session`);
    if (mcpServers.length > 0) {
      console.log(`   Servers: ${mcpServers.map(s => `${s.name} (${s.transport})`).join(', ')}`);
    }

    // Filter MCP servers: Codex ONLY supports stdio transport (not HTTP/SSE)
    const stdioServers = mcpServers.filter(s => s.transport === 'stdio');
    const unsupportedServers = mcpServers.filter(s => s.transport !== 'stdio');

    if (unsupportedServers.length > 0) {
      console.warn(
        `⚠️  [Codex MCP] ${unsupportedServers.length} MCP server(s) skipped - Codex only supports STDIO transport:`
      );
      for (const server of unsupportedServers) {
        console.warn(`   ❌ ${server.name} (${server.transport}) - not supported by Codex`);
      }
    }

    // Generate MCP servers TOML blocks (stdio only)
    let mcpServersToml = '';
    for (const server of stdioServers) {
      // Normalize server name to lowercase for TOML convention
      const serverName = server.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      console.log(`   📝 [Codex MCP] Configuring server: ${server.name} -> ${serverName}`);

      mcpServersToml += `\n[mcp_servers.${serverName}]\n`;
      if (server.command) {
        mcpServersToml += `command = "${server.command}"\n`;
        console.log(`      command: ${server.command}`);
      }
      if (server.args && server.args.length > 0) {
        const argsJson = JSON.stringify(server.args);
        mcpServersToml += `args = ${argsJson}\n`;
        console.log(`      args: ${argsJson}`);
      }

      // Add environment variables if present
      if (server.env && Object.keys(server.env).length > 0) {
        mcpServersToml += `\n[mcp_servers.${serverName}.env]\n`;
        const envCount = Object.keys(server.env).length;
        console.log(`      env vars: ${envCount} variable(s)`);
        for (const [key, value] of Object.entries(server.env)) {
          mcpServersToml += `${key} = "${value}"\n`;
        }
      }
    }

    // Generate network access TOML section (only for workspace-write sandbox)
    const networkAccessToml = networkAccess
      ? `\n[sandbox_workspace_write]\nnetwork_access = true\n`
      : '';

    // Generate complete config content
    const configContent = `# Codex configuration
# Generated by Agor - ${new Date().toISOString()}

# Approval policy controls when Codex asks before running commands
# Options: "untrusted", "on-request", "on-failure", "never"
approval_policy = "${approvalPolicy}"
${networkAccessToml}${mcpServersToml}`;

    // Create hash to detect changes (include network access in hash)
    const configHash = `${approvalPolicy}:${networkAccess}:${JSON.stringify(stdioServers.map(s => s.mcp_server_id))}`;

    // Skip if config hasn't changed (avoid unnecessary file I/O)
    if (this.lastMCPServersHash === configHash) {
      console.log(`✅ [Codex MCP] Config unchanged, skipping write`);
      return stdioServers.length;
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) {
      console.warn('⚠️  [Codex MCP] Could not determine home directory, skipping Codex config');
      return 0;
    }

    const codexConfigDir = path.join(homeDir, '.codex');
    const configPath = path.join(codexConfigDir, 'config.toml');

    console.log(`📁 [Codex MCP] Writing config to: ${configPath}`);
    console.log(`📄 [Codex MCP] Config content:\n${configContent}`);

    await fs.mkdir(codexConfigDir, { recursive: true });
    await fs.writeFile(configPath, configContent, 'utf-8');

    this.lastMCPServersHash = configHash;
    console.log(
      `✅ [Codex] Updated config.toml with approval_policy = "${approvalPolicy}", network_access = ${networkAccess}`
    );

    // Reinitialize Codex SDK to pick up the new config
    this.reinitializeCodex();
    if (stdioServers.length > 0) {
      console.log(
        `✅ [Codex MCP] Configured ${stdioServers.length} STDIO MCP server(s): ${stdioServers.map(s => s.name).join(', ')}`
      );
    }

    return stdioServers.length;
  }

  /**
   * Convert Codex item to ToolUse format
   * Maps different Codex item types to Agor tool use schema
   */
  private itemToToolUse(
    item: ThreadItem,
    status: 'started' | 'completed'
  ): {
    id: string;
    name: string;
    input: Record<string, unknown>;
    output?: string;
    status?: string;
  } | null {
    switch (item.type) {
      case 'command_execution':
        return {
          id: item.id,
          name: 'bash',
          input: { command: item.command },
          ...(status === 'completed' && {
            output: item.aggregated_output || '',
            status: item.status,
          }),
        };
      case 'file_change':
        return {
          id: item.id,
          name: 'edit_files',
          input: {
            changes: item.changes || [],
          },
          ...(status === 'completed' && {
            status: item.status,
          }),
        };
      case 'mcp_tool_call':
        return {
          id: item.id,
          name: `${item.server}.${item.tool}`,
          input: {},
          ...(status === 'completed' && {
            status: item.status,
          }),
        };
      case 'web_search':
        return {
          id: item.id,
          name: 'web_search',
          input: { query: item.query },
        };
      case 'reasoning':
        // Don't emit tool use for reasoning (it's internal)
        return null;
      case 'todo_list':
        // Don't emit tool use for todo list (it's internal)
        return null;
      case 'agent_message':
        // Don't emit tool use for text messages
        return null;
      default:
        return null;
    }
  }

  /**
   * Execute prompt with streaming support
   *
   * Uses Codex SDK's runStreamed() method for real-time event streaming.
   * Yields partial text chunks and complete messages.
   *
   * @param sessionId - Agor session ID
   * @param prompt - User prompt
   * @param taskId - Optional task ID
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @returns Async generator of streaming events
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    _taskId?: TaskID,
    permissionMode?: PermissionMode
  ): AsyncGenerator<CodexStreamEvent> {
    // Get session to check for existing thread ID and working directory
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Resolve per-user API key with precedence: per-user > global config > env var
    // This allows each user to have their own OPENAI_API_KEY
    const userIdForApiKey = session.created_by as import('../../types').UserID | undefined;
    const resolvedApiKey = await resolveApiKey('OPENAI_API_KEY', {
      userId: userIdForApiKey,
      db: this.db,
    });

    let currentApiKey = '';
    if (resolvedApiKey) {
      process.env.OPENAI_API_KEY = resolvedApiKey;
      currentApiKey = resolvedApiKey;
      console.log(
        `🔑 [Codex] Using per-user/global API key for ${userIdForApiKey?.substring(0, 8) ?? 'unknown user'}`
      );
    } else {
      // Clear stale API key to ensure SDK fails if no valid key is found
      delete process.env.OPENAI_API_KEY;
    }

    // Only recreate Codex client if API key changed (prevents memory leak - issue #133)
    // This ensures hot-reload of credentials from Settings UI while avoiding process accumulation
    this.refreshClient(currentApiKey);

    console.log(`🔍 [Codex] Starting prompt execution for session ${sessionId.substring(0, 8)}`);
    console.log(`   Permission mode: ${permissionMode || 'not specified (will use default)'}`);
    console.log(`   Existing thread ID: ${session.sdk_session_id || 'none (will create new)'}`);

    // HYBRID APPROACH: Codex permissions require THREE settings:
    // 1. sandboxMode (via ThreadOptions) - controls WHERE you can write
    // 2. approval_policy (via config.toml) - controls WHETHER agent asks before executing
    // 3. network_access (via config.toml) - controls network connectivity

    // Read from session.permission_config.codex (dual config), fallback to defaults
    const codexConfig = session.permission_config?.codex;
    const sandboxMode = codexConfig?.sandboxMode || 'workspace-write';
    const approvalPolicy = codexConfig?.approvalPolicy || 'on-request';
    const networkAccess = codexConfig?.networkAccess ?? false; // Default: disabled

    console.log(
      `   Using Codex permissions: sandboxMode=${sandboxMode}, approvalPolicy=${approvalPolicy}, networkAccess=${networkAccess}`
    );

    // Set approval_policy, network_access, and MCP servers in config.toml (required because they're not available in ThreadOptions)
    const mcpServerCount = await this.ensureCodexConfig(approvalPolicy, networkAccess, sessionId);

    const totalMcpServers = this.sessionMCPServerRepo
      ? (await this.sessionMCPServerRepo.listServers(sessionId, true)).length
      : 0;
    if (mcpServerCount < totalMcpServers) {
      console.log(
        `   Configured: sandboxMode=${sandboxMode}, approval_policy + ${mcpServerCount} STDIO MCP servers via config.toml (${totalMcpServers - mcpServerCount} HTTP/SSE servers skipped)`
      );
    } else {
      console.log(
        `   Configured: sandboxMode=${sandboxMode}, approval_policy + ${mcpServerCount} MCP server(s) via config.toml`
      );
    }

    // Fetch worktree to get working directory
    const worktree = this.worktreesRepo
      ? await this.worktreesRepo.findById(session.worktree_id)
      : null;
    if (!worktree) {
      throw new Error(`Worktree ${session.worktree_id} not found for session ${sessionId}`);
    }

    console.log(`   Working directory: ${worktree.path}`);

    // Build thread options with sandbox mode and worktree working directory
    const threadOptions = {
      workingDirectory: worktree.path,
      skipGitRepoCheck: false,
      sandboxMode,
    };

    // Check if we need to update thread settings due to approval policy change
    const previousApprovalPolicy = session.permission_config?.codex?.approvalPolicy || 'on-request';
    const approvalPolicyChanged = approvalPolicy !== previousApprovalPolicy;

    // Start or resume thread
    let thread: Thread;
    if (session.sdk_session_id) {
      console.log(`🔄 [Codex] Resuming thread: ${session.sdk_session_id}`);

      // IMPORTANT: Codex threads lock in MCP configuration at creation time
      // If MCP servers are configured now, warn that they might not be available in existing thread
      if (mcpServerCount > 0) {
        console.warn('⚠️  [Codex MCP] MCP servers are configured for this session.');
        console.warn(
          "   ⚠️  If this thread was created BEFORE MCP servers were added, it won't see them!"
        );
        console.warn('   🔧 SOLUTION: Create a NEW Agor session to pick up MCP servers.');
        console.warn(
          `   Current thread: ${session.sdk_session_id} (check if MCP servers are missing)`
        );
      }

      thread = this.codex.resumeThread(session.sdk_session_id, threadOptions);

      // If approval policy changed, send slash command to update thread settings
      if (approvalPolicyChanged) {
        console.log(
          `⚙️  [Codex] Approval policy changed: ${previousApprovalPolicy} → ${approvalPolicy}`
        );
        console.log(`   Sending slash command to update thread settings...`);

        // Send /approvals command to change approval policy mid-conversation
        // Note: sandboxMode is already updated via ThreadOptions on resumeThread()
        const slashCommand = `/approvals ${approvalPolicy}`;
        console.log(`   Executing: ${slashCommand}`);

        try {
          // Send the slash command and consume the response
          await thread.run(slashCommand);
          console.log(`✅ [Codex] Thread settings updated successfully`);
        } catch (error) {
          console.error(`❌ [Codex] Failed to update thread settings:`, error);
          // Continue anyway - the user's prompt will still be sent
        }
      }
    } else {
      console.log(`🆕 [Codex] Creating new thread`);
      if (mcpServerCount > 0) {
        console.log(
          `✅ [Codex MCP] New thread will have ${mcpServerCount} MCP server(s) available from config.toml`
        );
      }
      thread = this.codex.startThread(threadOptions);
    }

    try {
      console.log(
        `▶️  [Codex] Running prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`
      );

      // Resolve user environment variables and augment process.env
      // This allows the Codex subprocess to access per-user env vars
      const userIdForEnv = session.created_by as import('../../types').UserID | undefined;
      const originalProcessEnv = { ...process.env };
      let userEnvCount = 0;

      if (userIdForEnv && this.db) {
        try {
          const userEnv = await resolveUserEnvironment(userIdForEnv, this.db);
          // Count how many user env vars we're adding (exclude system vars)
          const systemVarCount = Object.keys(originalProcessEnv).length;
          const totalVarCount = Object.keys(userEnv).length;
          userEnvCount = totalVarCount - systemVarCount;

          // Augment process.env with user variables (user takes precedence)
          Object.assign(process.env, userEnv);

          if (userEnvCount > 0) {
            console.log(
              `🔐 [Codex] Augmented process.env with ${userEnvCount} user env vars for ${userIdForEnv.substring(0, 8)}`
            );
          }
        } catch (err) {
          console.error(`⚠️  [Codex] Failed to resolve user environment:`, err);
          // Continue without user env vars - non-fatal error
        }
      }

      // Use streaming API
      const { events } = await thread.runStreamed(prompt);

      let currentMessage: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }> = [];
      let threadId = session.sdk_session_id || '';
      let resolvedModel: string | undefined;
      let allToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for await (const event of events) {
        // Check if stop was requested
        if (this.stopRequested.get(sessionId)) {
          console.log(`🛑 Stop requested for session ${sessionId}, breaking event loop`);
          this.stopRequested.delete(sessionId);
          break;
        }

        switch (event.type) {
          case 'turn.started':
            allToolUses = []; // Reset tool uses for new turn
            break;

          case 'item.started':
            // Emit tool_start events for tool items
            if (event.item) {
              const toolUseStart = this.itemToToolUse(event.item, 'started');
              if (toolUseStart) {
                yield {
                  type: 'tool_start',
                  toolUse: toolUseStart,
                  threadId: thread.id || undefined,
                };
              }
            }
            break;

          case 'item.updated':
            // NOTE: Based on official OpenAI sample, item.updated is only emitted for todo_list items
            // agent_message, reasoning, command_execution, file_change only emit item.started/item.completed
            // We could handle todo_list progress here if needed in the future
            // For now, we ignore item.updated since we don't track todo lists
            break;

          case 'item.completed':
            // Collect completed items and emit tool_complete events
            if (event.item) {
              // Emit tool_complete for tool items
              const toolUseComplete = this.itemToToolUse(event.item, 'completed');
              if (toolUseComplete) {
                // Add to allToolUses for backward compatibility (tool_uses field)
                allToolUses.push({
                  id: toolUseComplete.id,
                  name: toolUseComplete.name,
                  input: toolUseComplete.input,
                });

                // Add tool_use block to content array (for UI rendering)
                currentMessage.push({
                  type: 'tool_use',
                  id: toolUseComplete.id,
                  name: toolUseComplete.name,
                  input: toolUseComplete.input,
                });

                // Add tool_result block if we have output OR status (for UI rendering)
                if (toolUseComplete.output !== undefined || toolUseComplete.status) {
                  const isError =
                    toolUseComplete.status === 'failed' || toolUseComplete.status === 'error';

                  // Build content: prefer output, fall back to status message
                  let content = toolUseComplete.output || '';
                  if (!content && toolUseComplete.status) {
                    content = `[${toolUseComplete.status}]`;
                  }

                  currentMessage.push({
                    type: 'tool_result',
                    tool_use_id: toolUseComplete.id,
                    content,
                    is_error: isError,
                  });
                }

                yield {
                  type: 'tool_complete',
                  toolUse: toolUseComplete,
                  threadId: thread.id || undefined,
                };
              }

              // Store text items for final message
              if ('text' in event.item && event.item.type === 'agent_message') {
                currentMessage.push({
                  type: 'text',
                  text: event.item.text as string,
                });
              }
            }
            break;

          case 'turn.completed': {
            // Turn complete, emit final message
            threadId = thread.id || '';

            // Yield complete message with all tool uses
            yield {
              type: 'complete',
              content: currentMessage,
              toolUses: allToolUses.length > 0 ? allToolUses : undefined,
              threadId,
              resolvedModel: resolvedModel || DEFAULT_CODEX_MODEL,
            };

            // Reset for next message
            currentMessage = [];
            allToolUses = [];
            break;
          }

          case 'turn.failed':
            console.error('❌ Codex turn failed:', event.error);
            throw new Error(`Codex execution failed: ${event.error}`);

          default:
            // Ignore other event types silently
            break;
        }
      }
    } catch (error) {
      console.error('❌ Codex streaming error:', error);
      throw error;
    }
  }

  /**
   * Execute prompt (non-streaming version)
   *
   * Collects all streaming events and returns complete result.
   *
   * @param sessionId - Agor session ID
   * @param prompt - User prompt
   * @param taskId - Optional task ID
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @returns Complete prompt result
   */
  async promptSession(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): Promise<CodexPromptResult> {
    // Note: promptSessionStreaming will handle per-user API key resolution and refreshClient()
    const messages: CodexPromptResult['messages'] = [];
    let threadId = '';
    const inputTokens = 0;
    const outputTokens = 0;

    for await (const event of this.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      if (event.type === 'complete') {
        messages.push({
          content: event.content,
          toolUses: event.toolUses,
        });
        threadId = event.threadId;
      }
      // Skip partial events in non-streaming mode
    }

    return {
      messages,
      inputTokens,
      outputTokens,
      threadId,
    };
  }

  /**
   * Stop currently executing task
   *
   * Sets a stop flag that is checked in the event loop.
   * The loop will break on the next iteration, stopping execution gracefully.
   *
   * @param sessionId - Session identifier
   * @returns Success status
   */
  stopTask(sessionId: SessionID): { success: boolean; reason?: string } {
    // Set stop flag
    this.stopRequested.set(sessionId, true);
    console.log(`🛑 Stop requested for Codex session ${sessionId}`);

    return { success: true };
  }
}
