/**
 * Gemini Prompt Service - Handles live execution via @google/gemini-cli-core SDK
 *
 * Features:
 * - Token-level streaming via AsyncGenerator
 * - Session continuity via setHistory()
 * - Permission modes (DEFAULT, AUTO_EDIT, YOLO)
 * - Event-driven architecture (13 event types)
 * - CLAUDE.md auto-loading
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthType,
  Config,
  executeToolCall,
  GeminiClient,
  GeminiEventType,
  MCPServerConfig,
  type ResumedSessionData,
} from '@google/gemini-cli-core';
import type { Part } from '@google/genai';
import { getDaemonUrl, resolveApiKey, resolveUserEnvironment } from '../../config';
import type { Database } from '../../db/client';
import type { MCPServerRepository } from '../../db/repositories/mcp-servers';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { WorktreeRepository } from '../../db/repositories/worktrees';
import type { PermissionMode, SessionID, TaskID, UserID } from '../../types';
import type { TokenUsage } from '../../types/token-usage';
import { convertConversationToHistory } from './conversation-converter';
import { DEFAULT_GEMINI_MODEL, type GeminiModel } from './models';
import { mapPermissionMode } from './permission-mapper';
import { extractGeminiTokenUsage } from './usage';

/**
 * GeminiClient with internal config property exposed
 * The SDK doesn't expose this in types, but we need it for executeToolCall()
 * Note: config is private in GeminiClient, so we use unknown cast
 */
interface GeminiClientWithConfig {
  config: Config;
}

/**
 * Streaming event types for prompt service consumers
 */
export type GeminiStreamEvent =
  | {
      type: 'partial';
      textChunk: string;
      resolvedModel?: string;
      sessionId?: string;
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
      toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      resolvedModel?: string;
      sessionId?: string;
      usage?: TokenUsage;
      rawSdkResponse?: import('../../types/sdk-response').GeminiSdkResponse; // The actual response from Gemini SDK
    }
  | {
      type: 'tool_start';
      toolName: string;
      toolInput: Record<string, unknown>;
    }
  | {
      type: 'tool_complete';
      toolName: string;
      result: unknown;
    };

export class GeminiPromptService {
  private sessionClients = new Map<SessionID, GeminiClient>();
  private activeControllers = new Map<SessionID, AbortController>();
  private db?: Database;
  private tasksService?: { get: (id: TaskID) => Promise<{ created_by: string }> };

  constructor(
    _messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    _apiKey?: string,
    private worktreesRepo?: WorktreeRepository,
    private mcpServerRepo?: MCPServerRepository,
    private sessionMCPRepo?: SessionMCPServerRepository,
    private mcpEnabled?: boolean,
    db?: Database,
    tasksService?: { get: (id: TaskID) => Promise<{ created_by: string }> }
  ) {
    this.db = db;
    this.tasksService = tasksService;
  }

  /**
   * Execute prompt with streaming via @google/gemini-cli-core SDK
   *
   * @param sessionId - Agor session ID
   * @param prompt - User prompt text
   * @param taskId - Optional task ID for message linking
   * @param permissionMode - Agor permission mode ('ask' | 'auto' | 'allow-all')
   * @yields Streaming events (partial chunks and complete messages)
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): AsyncGenerator<GeminiStreamEvent> {
    // Get session metadata for model
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Determine which user's context to use for environment variables and API keys
    // Priority: task creator (if task exists) > session owner (fallback)
    let contextUserId = session.created_by as UserID | undefined;

    if (taskId && this.tasksService) {
      try {
        const task = await this.tasksService.get(taskId);
        if (task?.created_by) {
          contextUserId = task.created_by as UserID;
        }
      } catch (_err) {
        // Fall back to session owner if task not found
      }
    }

    // Get or create Gemini client for this session (passing contextUserId for API key resolution)
    const client = await this.getOrCreateClient(sessionId, permissionMode, contextUserId);

    const model = (session.model_config?.model as GeminiModel) || DEFAULT_GEMINI_MODEL;

    // Prepare initial prompt (just text for now - can enhance with file paths later)
    let parts: Part[] = [{ text: prompt }];

    // Create abort controller for cancellation support
    const abortController = new AbortController();
    this.activeControllers.set(sessionId, abortController);

    // Generate unique prompt ID for this turn
    const promptId = `${sessionId}-${Date.now()}`;

    try {
      // Tool execution loop - keep going until no more tool calls
      let loopCount = 0;
      const MAX_LOOPS = 50; // Safety limit to prevent infinite loops

      while (loopCount < MAX_LOOPS) {
        loopCount++;
        console.debug(`[Gemini Loop ${loopCount}] Starting turn with ${parts.length} parts`);

        // Resolve user environment variables and augment process.env
        // This allows the Gemini subprocess to access per-user env vars
        const originalProcessEnv = { ...process.env };
        let userEnvCount = 0;

        if (contextUserId && this.db) {
          try {
            const userEnv = await resolveUserEnvironment(contextUserId, this.db);
            // Count how many user env vars we're adding (exclude system vars)
            const systemVarCount = Object.keys(originalProcessEnv).length;
            const totalVarCount = Object.keys(userEnv).length;
            userEnvCount = totalVarCount - systemVarCount;

            // Augment process.env with user variables (user takes precedence)
            Object.assign(process.env, userEnv);

            if (userEnvCount > 0 && loopCount === 1) {
              // Only log on first iteration to avoid spam
              console.log(
                `🔐 [Gemini] Augmented process.env with ${userEnvCount} user env vars for ${contextUserId.substring(0, 8)}`
              );
            }
          } catch (err) {
            console.error(`⚠️  [Gemini] Failed to resolve user environment:`, err);
            // Continue without user env vars - non-fatal error
          }
        }

        // Stream events from Gemini SDK
        const stream = client.sendMessageStream(parts, abortController.signal, promptId);

        // Accumulate content blocks for THIS turn (reset after Finished event)
        let fullTextContent = '';
        const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
        const pendingToolCalls: Array<{
          callId: string;
          name: string;
          args: Record<string, unknown>;
        }> = [];

        // Stream all events from this turn
        for await (const event of stream) {
          // Debug logging for all events
          const eventValue = 'value' in event ? event.value : undefined;
          console.debug(
            `[Gemini Event] ${event.type}:`,
            eventValue ? JSON.stringify(eventValue).slice(0, 100) : '(no value)'
          );

          // Handle different event types from Gemini SDK
          switch (event.type) {
            case GeminiEventType.Content: {
              // Text chunk from model - stream it immediately!
              const textChunk = event.value || '';
              fullTextContent += textChunk;

              yield {
                type: 'partial',
                textChunk,
                resolvedModel: model,
                sessionId,
              };
              break;
            }

            case GeminiEventType.ToolCallRequest: {
              // Agent wants to call a tool
              let { name, args, callId } = event.value;

              // Normalize tool names to match Claude Code conventions (PascalCase)
              // This ensures UI renderers work consistently across all agents
              if (
                name?.toLowerCase() === 'bash' ||
                name === 'ExecuteCommand' ||
                name === 'command'
              ) {
                name = 'Bash';
              }

              // Track tool use for complete message
              toolUses.push({
                id: callId,
                name,
                input: args,
              });

              // Track pending tool call for loop continuation
              pendingToolCalls.push({
                callId,
                name,
                args,
              });

              // Notify consumer that tool started
              yield {
                type: 'tool_start',
                toolName: name,
                toolInput: args,
              };
              break;
            }

            case GeminiEventType.ToolCallResponse: {
              // Tool execution completed
              const toolResponse = event.value as unknown as Record<string, unknown>;

              yield {
                type: 'tool_complete',
                toolName: (toolResponse.name as string) || 'unknown',
                result: toolResponse.response || toolResponse,
              };
              break;
            }

            case GeminiEventType.Finished: {
              // Turn complete - yield final message (if we have any content)
              console.debug(
                `[Gemini Turn Finished] Text: ${fullTextContent.length} chars, Tools: ${toolUses.length}`
              );

              // Type-assert event as ServerGeminiFinishedEvent since we're in Finished case
              const finishedEvent = event as import('../../types/sdk-response').GeminiSdkResponse;

              // Extract token usage from SDK response
              const mappedUsage = extractGeminiTokenUsage(finishedEvent.value?.usageMetadata);

              const content: Array<{
                type: string;
                text?: string;
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
              }> = [];

              // Add text block if we have content
              if (fullTextContent) {
                content.push({
                  type: 'text',
                  text: fullTextContent,
                });
              }

              // Add tool use blocks
              for (const toolUse of toolUses) {
                content.push({
                  type: 'tool_use',
                  id: toolUse.id,
                  name: toolUse.name,
                  input: toolUse.input,
                });
              }

              // Only yield complete message if we actually have content
              if (content.length > 0) {
                yield {
                  type: 'complete',
                  content,
                  toolUses: toolUses.length > 0 ? toolUses : undefined,
                  resolvedModel: model,
                  sessionId,
                  usage: mappedUsage,
                  rawSdkResponse: finishedEvent, // Pass through the actual SDK response (UNMUTATED)
                };
              }

              // Update session history for continuity
              await this.updateSessionHistory(sessionId, client);
              break;
            }

            case GeminiEventType.Error: {
              // Error occurred during execution
              const errorValue = 'value' in event ? event.value : 'Unknown error';
              console.error(`Gemini SDK error: ${JSON.stringify(errorValue)}`);

              // Extract meaningful error message
              let errorMessage = 'Unknown error';
              if (typeof errorValue === 'object' && errorValue !== null) {
                if (
                  'error' in errorValue &&
                  typeof errorValue.error === 'object' &&
                  errorValue.error !== null
                ) {
                  const errorObj = errorValue.error as { message?: string };
                  errorMessage = errorObj.message || JSON.stringify(errorValue);
                } else {
                  errorMessage = JSON.stringify(errorValue);
                }
              } else if (typeof errorValue === 'string') {
                errorMessage = errorValue;
              }

              throw new Error(`Gemini execution failed: ${errorMessage}`);
            }

            case GeminiEventType.Thought: {
              // Agent thinking/reasoning (could stream to UI in future)
              const thoughtValue = 'value' in event ? event.value : '';
              console.debug(`[Gemini Thought] ${thoughtValue}`);
              break;
            }

            case GeminiEventType.ToolCallConfirmation: {
              // User approval needed (should be handled by ApprovalMode config)
              console.warn(
                '[Gemini] Tool call needs confirmation - this should not happen in AUTO_EDIT/YOLO mode!'
              );
              console.warn('[Gemini] Confirmation details:', JSON.stringify(event.value, null, 2));
              break;
            }

            default: {
              // Log other event types for debugging
              const debugValue = 'value' in event ? event.value : '';
              console.debug(`[Gemini Event] ${event.type}:`, debugValue);
              break;
            }
          }
        }

        // Check if there are pending tool calls that need execution
        if (pendingToolCalls.length === 0) {
          console.debug('[Gemini Loop] No pending tool calls - conversation complete!');
          break; // No more tools to execute, we're done!
        }

        console.debug(`[Gemini Loop] Found ${pendingToolCalls.length} pending tool calls`);

        // CRITICAL: The Gemini SDK does NOT auto-execute tools in streaming mode!
        // We need to manually execute the tools using SDK's executeToolCall() and send results back.

        // Get config for executeToolCall
        const config = (client as unknown as GeminiClientWithConfig).config;

        // Execute all pending tool calls using SDK's executeToolCall function
        const functionResponseParts: Part[] = [];

        for (const toolCall of pendingToolCalls) {
          try {
            console.debug(
              `[Gemini Loop] Executing tool: ${toolCall.name} with args:`,
              JSON.stringify(toolCall.args).slice(0, 100)
            );

            // Use SDK's executeToolCall function instead of manually calling tool.execute()
            const response = await executeToolCall(
              config,
              {
                callId: toolCall.callId,
                name: toolCall.name,
                args: toolCall.args,
                isClientInitiated: false,
                prompt_id: promptId,
              },
              abortController.signal
            );
            console.debug(`[Gemini Loop] Tool ${toolCall.name} executed successfully:`, response);

            // In SDK 0.15.1, the response structure changed
            // ToolCallResponseInfo has { callId, output } instead of { status, result }
            // Create function response part from the tool call output
            const responseOutput =
              typeof response === 'object' && response && 'output' in response
                ? response.output
                : response;
            functionResponseParts.push({
              functionResponse: {
                name: toolCall.name,
                response: responseOutput,
              },
            } as Part);
          } catch (error) {
            console.error(`[Gemini Loop] Error executing tool ${toolCall.name}:`, error);
            // On error, create a function response part with the error
            functionResponseParts.push({
              functionResponse: {
                name: toolCall.name,
                response: { error: String(error) },
              },
            } as Part);
          }
        }

        // Prepare next message with tool results
        // Send the function responses back to the model to get its response
        parts = functionResponseParts;
        console.debug(
          `[Gemini Loop] Sending ${functionResponseParts.length} tool result parts back to model...`
        );

        // Loop will continue with the function response parts sent to the model
      }

      if (loopCount >= MAX_LOOPS) {
        console.warn(
          `[Gemini Loop] Hit maximum loop count (${MAX_LOOPS}) - stopping to prevent infinite loop`
        );
      }
    } catch (error) {
      // Check if error is from abort
      if (error instanceof Error && error.name === 'AbortError') {
        console.log(`🛑 Gemini execution stopped for session ${sessionId}`);
        // Don't re-throw abort errors - this is expected behavior
        return;
      }
      console.error('Gemini streaming error:', error);
      throw error;
    } finally {
      // Clean up abort controller
      this.activeControllers.delete(sessionId);
    }
  }

  /**
   * Load session file from SDK's filesystem storage
   *
   * Searches for session file in ~/.gemini/tmp/{projectHash}/chats/
   * matching pattern: session-*-{sessionId-first8}.json
   */
  private async loadSessionFile(
    sessionId: SessionID,
    projectRoot: string
  ): Promise<ResumedSessionData | null> {
    try {
      // Calculate project hash (same as SDK does)
      const projectHash = crypto.createHash('sha256').update(projectRoot).digest('hex');
      const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectHash, 'chats');

      // Check if chats directory exists
      try {
        await fs.access(chatsDir);
      } catch {
        console.debug(`No chats directory found for project ${projectRoot}`);
        return null;
      }

      // Find session file matching pattern: session-*-{sessionId-first8}.json
      const sessionIdShort = sessionId.slice(0, 8);
      const files = await fs.readdir(chatsDir);
      const sessionFile = files.find((f) => f.includes(sessionIdShort) && f.endsWith('.json'));

      if (!sessionFile) {
        console.debug(`No session file found for ${sessionId} (looking for *${sessionIdShort}*)`);
        return null;
      }

      // Load and parse the conversation file
      const filePath = path.join(chatsDir, sessionFile);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const conversation = JSON.parse(fileContent);

      console.log(`📂 Found session file: ${sessionFile}`);
      return { conversation, filePath };
    } catch (error) {
      console.error('Error loading session file:', error);
      return null;
    }
  }

  /**
   * Get or create GeminiClient for a session
   *
   * Manages client lifecycle and session continuity via history restoration.
   */
  private async getOrCreateClient(
    sessionId: SessionID,
    permissionMode?: PermissionMode,
    contextUserId?: import('../../types').UserID
  ): Promise<GeminiClient> {
    // Resolve per-user API key FIRST, before checking for existing client
    // This ensures we use the correct key even when reusing a cached client
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Use provided contextUserId (task creator) or fall back to session owner
    const userIdForApiKey = contextUserId || (session.created_by as UserID | undefined);
    const resolvedApiKey = await resolveApiKey('GEMINI_API_KEY', {
      userId: userIdForApiKey,
      db: this.db,
    });

    // Determine auth type: OAuth if no API key, otherwise API key
    let authType: AuthType;
    if (resolvedApiKey) {
      process.env.GEMINI_API_KEY = resolvedApiKey;
      authType = AuthType.USE_GEMINI;
      console.log(
        `🔑 [Gemini] Using per-user/global API key for ${userIdForApiKey?.substring(0, 8) ?? 'unknown user'}`
      );
    } else {
      // No API key found - use OAuth authentication via Gemini CLI
      authType = AuthType.LOGIN_WITH_GOOGLE;
      console.log('🔐 [Gemini] No API key found, using OAuth authentication (Gemini CLI)');
      delete process.env.GEMINI_API_KEY;
    }

    // Map Agor permission mode to Gemini ApprovalMode
    const approvalMode = mapPermissionMode(permissionMode || 'ask');

    // Check if client exists - NEVER clear the cache to preserve conversation history
    if (this.sessionClients.has(sessionId)) {
      const existingClient = this.sessionClients.get(sessionId)!;
      const config = (existingClient as unknown as GeminiClientWithConfig).config;

      // Update approval mode on existing client (in case it changed)
      if (config && typeof config.setApprovalMode === 'function') {
        config.setApprovalMode(approvalMode);
        console.log(`🔄 [Gemini] Updated approval mode for existing client: ${approvalMode}`);
      }

      // For API key hot-reload: Call refreshAuth() which reads from process.env.GEMINI_API_KEY
      // Config service updates process.env when credentials change, so this picks up new keys
      // Note: refreshAuth() might fail if the key is invalid, but we log and continue
      if (config && typeof config.refreshAuth === 'function') {
        try {
          // Re-determine auth type based on current API key state
          const currentAuthType = process.env.GEMINI_API_KEY
            ? AuthType.USE_GEMINI
            : AuthType.LOGIN_WITH_GOOGLE;
          await config.refreshAuth(currentAuthType);
          const authMethod = currentAuthType === AuthType.LOGIN_WITH_GOOGLE ? 'OAuth' : 'API key';
          console.log(`🔄 [Gemini] Refreshed authentication using ${authMethod}`);
        } catch (error) {
          // Log but don't throw - let the subsequent prompt attempt fail with a better error
          console.warn(
            `⚠️  [Gemini] refreshAuth() failed: ${error instanceof Error ? error.message : String(error)}`
          );
          console.warn(`   Continuing anyway - prompt may fail if credentials are invalid`);
        }
      }

      return existingClient;
    }

    // Session was already fetched above for API key resolution
    // Determine working directory from worktree (worktree-centric architecture)
    let workingDirectory = process.cwd();
    if (session.worktree_id && this.worktreesRepo) {
      try {
        const worktree = await this.worktreesRepo.findById(session.worktree_id);
        if (worktree) {
          workingDirectory = worktree.path;
          console.log(`✅ Using worktree path as cwd: ${workingDirectory}`);
        } else {
          console.warn(
            `⚠️  Session ${sessionId} references non-existent worktree ${session.worktree_id}, using process.cwd(): ${workingDirectory}`
          );
        }
      } catch (error) {
        console.error(`❌ Failed to fetch worktree ${session.worktree_id}:`, error);
        console.warn(`   Falling back to process.cwd(): ${workingDirectory}`);
      }
    } else if (!this.worktreesRepo) {
      console.warn(
        `⚠️  GeminiPromptService initialized without worktreesRepo, using process.cwd(): ${workingDirectory}`
      );
    } else {
      console.warn(
        `⚠️  Session ${sessionId} has no worktree_id, using process.cwd(): ${workingDirectory}`
      );
    }

    // Get model from session config
    const model = (session.model_config?.model as GeminiModel) || DEFAULT_GEMINI_MODEL;

    // approvalMode already mapped at top of function
    console.log(
      `🔧 [Gemini] Creating new client with approval mode: ${permissionMode || 'ask'} → ${approvalMode}`
    );

    // Check for CLAUDE.md and load it as system context
    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    let systemPrompt: string | undefined;
    try {
      const claudeMdContent = await fs.readFile(claudeMdPath, 'utf-8');
      systemPrompt = `# Project Context\n\n${claudeMdContent}`;
      console.log(`📖 Loaded CLAUDE.md from ${claudeMdPath}`);
    } catch {
      // CLAUDE.md doesn't exist - that's okay
    }

    // Fetch and configure MCP servers for this session (hierarchical scoping)
    const mcpServersConfig: Record<string, MCPServerConfig> = {};

    // Configure Agor MCP server (self-access to daemon) - only if MCP is enabled
    if (this.mcpEnabled !== false) {
      const mcpToken = session.mcp_token;
      console.log(`🔍 [MCP DEBUG] Checking for MCP token in session ${sessionId.substring(0, 8)}`);
      console.log(
        `   session.mcp_token: ${mcpToken ? `${mcpToken.substring(0, 16)}...` : 'NOT FOUND'}`
      );

      if (mcpToken) {
        // Get daemon URL from config (supports Codespaces auto-detection)
        const daemonUrl = await getDaemonUrl();

        console.log(`🔌 Configuring Agor MCP server (self-access to daemon)`);
        // Use httpUrl parameter for HTTP transport
        mcpServersConfig.agor = new MCPServerConfig(
          undefined, // command
          undefined, // args
          {}, // env
          undefined, // cwd
          undefined, // url (websocket)
          `${daemonUrl}/mcp?sessionToken=${mcpToken}`, // httpUrl
          {} // headers
        );
        console.log(
          `   Agor MCP URL: ${daemonUrl}/mcp?sessionToken=${mcpToken.substring(0, 16)}...`
        );
      } else {
        console.warn(`⚠️  No MCP token found for session ${sessionId.substring(0, 8)}`);
        console.warn(`   Session will not have access to Agor MCP tools`);
      }
    } else {
      console.log(`🔒 Agor MCP server disabled - skipping MCP configuration`);
    }

    // Fetch user-configured MCP servers
    if (this.sessionMCPRepo && this.mcpServerRepo) {
      try {
        const allServers: Array<{
          // biome-ignore lint/suspicious/noExplicitAny: MCPServer type from database
          server: any;
          source: string;
        }> = [];

        // 1. Global servers (always included)
        console.log('🔌 Fetching MCP servers with hierarchical scoping...');
        const globalServers = await this.mcpServerRepo.findAll({
          scope: 'global',
          enabled: true,
        });
        console.log(`   📍 Global scope: ${globalServers?.length ?? 0} server(s)`);
        for (const server of globalServers ?? []) {
          allServers.push({ server, source: 'global' });
        }

        // 2. Repo-scoped servers (if session has a worktree)
        let repoId: string | undefined;
        if (session.worktree_id && this.worktreesRepo) {
          const worktree = await this.worktreesRepo.findById(session.worktree_id);
          repoId = worktree?.repo_id;
        }
        if (repoId) {
          const repoServers = await this.mcpServerRepo.findAll({
            scope: 'repo',
            scopeId: repoId,
            enabled: true,
          });
          console.log(`   📍 Repo scope: ${repoServers?.length ?? 0} server(s)`);
          for (const server of repoServers ?? []) {
            allServers.push({ server, source: 'repo' });
          }
        }

        // 3. Session-specific servers (from join table)
        const sessionServers = await this.sessionMCPRepo.listServers(sessionId, true); // enabledOnly
        console.log(`   📍 Session scope: ${sessionServers.length} server(s)`);
        for (const server of sessionServers) {
          allServers.push({ server, source: 'session' });
        }

        // 4. Deduplicate by server ID (later scopes override earlier ones)
        // This means: session > repo > global
        const serverMap = new Map<
          string,
          {
            // biome-ignore lint/suspicious/noExplicitAny: MCPServer type from database
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

        // 5. Convert to Gemini SDK format
        for (const { server, source } of uniqueServers) {
          console.log(`   - ${server.name} (${server.transport}) [${source}]`);

          // Convert Agor's MCP server format to Gemini SDK's MCPServerConfig
          if (server.transport === 'stdio') {
            mcpServersConfig[server.name] = new MCPServerConfig(
              server.command,
              server.args || [],
              server.env || {},
              workingDirectory // Use worktree path as cwd
            );
          } else if (server.transport === 'http') {
            // HTTP transport: use httpUrl parameter
            mcpServersConfig[server.name] = new MCPServerConfig(
              undefined, // command
              undefined, // args
              server.env || {},
              undefined, // cwd
              undefined, // url (websocket)
              server.url, // httpUrl
              server.headers || {} // headers
            );
          } else if (server.transport === 'sse') {
            // SSE transport: use url parameter (websocket/sse)
            mcpServersConfig[server.name] = new MCPServerConfig(
              undefined, // command
              undefined, // args
              server.env || {},
              undefined, // cwd
              server.url // url (websocket/sse)
            );
          }
        }

        if (Object.keys(mcpServersConfig).length > 0) {
          console.log(
            `   🔧 MCP config for Gemini SDK:`,
            JSON.stringify(
              Object.keys(mcpServersConfig).reduce(
                (acc, key) => {
                  acc[key] = {
                    transport: mcpServersConfig[key].command ? 'stdio' : 'http/sse',
                  };
                  return acc;
                },
                {} as Record<string, { transport: string }>
              ),
              null,
              2
            )
          );
        }
      } catch (error) {
        console.warn('⚠️  Failed to fetch MCP servers for Gemini session:', error);
        // Continue without MCP servers - non-fatal error
      }
    }

    // Create SDK config
    const config = new Config({
      sessionId, // Use Agor session ID
      targetDir: workingDirectory,
      cwd: workingDirectory,
      model,
      interactive: false, // Use non-interactive mode (we'll handle tool execution ourselves)
      approvalMode,
      debugMode: true, // Enable debug logging to see what's happening
      folderTrust: true, // CRITICAL: Trust folder to allow YOLO/AUTO_EDIT modes
      trustedFolder: true, // CRITICAL: Mark folder as trusted
      fileFiltering: {
        respectGitIgnore: true,
        respectGeminiIgnore: true,
      },
      mcpServers: Object.keys(mcpServersConfig).length > 0 ? mcpServersConfig : undefined,
      // output: { format: 'stream-json' }, // Streaming JSON events (omitting for now - may not be needed)
      // System prompt will be added via first message if provided
    });

    // CRITICAL: Initialize config first to set up tool registry, etc.
    await config.initialize();

    // NOTE: API key was already resolved in getOrCreateClient() before client was reused/created
    // So process.env.GEMINI_API_KEY is already set with the correct per-user or global key

    // CRITICAL: Set up authentication (creates ContentGenerator and BaseLlmClient)
    // Use authType determined above (OAuth or API key)
    // The SDK will look for GEMINI_API_KEY environment variable (if using API key)
    // or use OAuth credentials from ~/.gemini/oauth_creds.json (if using OAuth)
    await config.refreshAuth(authType);
    const authMethod = authType === AuthType.LOGIN_WITH_GOOGLE ? 'OAuth' : 'API key';
    console.log(`🔐 [Gemini] Authenticated using ${authMethod}`);

    // Try to load existing session file from SDK's filesystem storage
    const resumedSessionData = await this.loadSessionFile(sessionId, workingDirectory);

    // Create client (config must be initialized and authenticated first!)
    const client = new GeminiClient(config);
    await client.initialize();

    // CRITICAL: Set tools for the client (this triggers MCP tool discovery and registration)
    await client.setTools();
    console.log('🔧 Tools initialized for Gemini client');

    // Check if we have existing conversation history
    let hasExistingHistory = false;
    if (resumedSessionData) {
      // Use SDK's native resumption mechanism
      const recordingService = client.getChatRecordingService();
      if (recordingService) {
        recordingService.initialize(resumedSessionData);
        console.log(
          `🔄 Resumed session from file: ${resumedSessionData.conversation.messages.length} messages`
        );
        hasExistingHistory = true;

        // Also restore to client history for API continuity
        // Convert ConversationRecord messages to Content[] format
        const history = convertConversationToHistory(resumedSessionData.conversation);
        client.setHistory(history);
      }
    }

    // Add system prompt as first message if CLAUDE.md exists
    if (systemPrompt && !hasExistingHistory) {
      // Will be added on first user message
    }

    // Cache client for reuse
    this.sessionClients.set(sessionId, client);

    return client;
  }

  /**
   * Map Agor permission mode to Gemini ApprovalMode
   *
   * Gemini SDK supports 3 modes:
   * - DEFAULT: Prompt for each tool use
   * - AUTO_EDIT: Auto-approve file edits, prompt for shell/web commands
   * - YOLO: Auto-approve all operations
   */
  /**
   * Update session history after turn completion
   *
   * The SDK's ChatRecordingService automatically persists to filesystem,
   * so we just log for debugging purposes.
   */
  private async updateSessionHistory(sessionId: SessionID, client: GeminiClient): Promise<void> {
    const history = client.getHistory();
    const recordingService = client.getChatRecordingService();

    if (recordingService) {
      console.debug(
        `📝 Session ${sessionId} history updated: ${history.length} turns (auto-saved to filesystem)`
      );
    } else {
      console.warn(
        `⚠️  No ChatRecordingService found for session ${sessionId} - history not persisted`
      );
    }
  }

  /**
   * Stop currently executing task
   *
   * Calls abort() on the AbortController to gracefully stop streaming.
   *
   * @param sessionId - Session identifier
   * @returns Success status
   */
  stopTask(sessionId: SessionID): { success: boolean; reason?: string } {
    const controller = this.activeControllers.get(sessionId);
    if (!controller) {
      return {
        success: false,
        reason: 'No active task found for this session',
      };
    }

    // Abort the streaming request
    controller.abort();
    console.log(`🛑 Stopping Gemini task for session ${sessionId}`);

    return { success: true };
  }

  /**
   * Clean up client for a session (e.g., on session close)
   */
  async closeSession(sessionId: SessionID): Promise<void> {
    const client = this.sessionClients.get(sessionId);
    if (client) {
      await client.resetChat(); // Clear history
      this.sessionClients.delete(sessionId);
      console.log(`🗑️  Closed Gemini client for session ${sessionId}`);
    }
  }
}
