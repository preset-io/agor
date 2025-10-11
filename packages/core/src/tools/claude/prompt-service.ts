/**
 * Claude Prompt Service
 *
 * Handles live execution of prompts against Claude sessions using Claude Agent SDK.
 * Automatically loads CLAUDE.md and uses preset system prompts matching Claude Code CLI.
 */

import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { MCPServersConfig, Message, SessionID } from '../../types';

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
  constructor(
    private messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private apiKey?: string,
    private sessionMCPRepo?: SessionMCPServerRepository
  ) {
    // No client initialization needed - Agent SDK is stateless
  }

  /**
   * Load session and initialize query
   * @private
   */
  private async setupQuery(sessionId: SessionID, prompt: string, resume = true) {
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.logPromptStart(
      sessionId,
      prompt,
      session.repo.cwd,
      resume ? session.agent_session_id : undefined
    );

    const options: Record<string, unknown> = {
      cwd: session.repo.cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'], // Auto-loads CLAUDE.md
      model: 'claude-sonnet-4-5-20250929',
      pathToClaudeCodeExecutable: getClaudeCodePath(),
    };

    // Add optional apiKey if provided
    if (this.apiKey || process.env.ANTHROPIC_API_KEY) {
      options.apiKey = this.apiKey || process.env.ANTHROPIC_API_KEY;
    }

    // Add optional resume if session exists
    if (resume && session.agent_session_id) {
      options.resume = session.agent_session_id;
    }

    // Fetch and configure MCP servers for this session
    if (this.sessionMCPRepo) {
      try {
        const mcpServers = await this.sessionMCPRepo.listServers(sessionId, true); // enabledOnly
        if (mcpServers.length > 0) {
          console.log(
            `🔌 Found ${mcpServers.length} enabled MCP server(s) for session ${sessionId}`
          );

          // Convert to SDK format
          const mcpConfig: MCPServersConfig = {};
          const allowedTools: string[] = [];

          for (const server of mcpServers) {
            console.log(`   - ${server.name} (${server.transport})`);

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

    const result = query({
      prompt,
      // biome-ignore lint/suspicious/noExplicitAny: SDK Options type doesn't include all available fields
      options: options as any,
    });

    return result;
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
    console.log(`🤖 Prompting Claude for session ${sessionId}...`);
    console.log(`   CWD: ${cwd}`);
    console.log(`   Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`);
    if (agentSessionId) {
      console.log(`   📚 Resuming Agent SDK session: ${agentSessionId}`);
    }
    console.log('📤 Calling Agent SDK query()...');
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
    console.log(
      `   [Message ${messageNum}] Content type: ${Array.isArray(content) ? 'array' : typeof content}`
    );

    const contentBlocks: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }> = [];

    if (typeof content === 'string') {
      contentBlocks.push({ type: 'text', text: content });
      console.log(`   [Message ${messageNum}] Added text block: ${content.length} chars`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        contentBlocks.push(block);
        if (block.type === 'text') {
          console.log(
            `   [Message ${messageNum}] Added text block: ${block.text?.length || 0} chars`
          );
        } else if (block.type === 'tool_use') {
          console.log(`   [Message ${messageNum}] Added tool_use: ${block.name}`);
        } else {
          console.log(`   [Message ${messageNum}] Added block type: ${block.type}`);
        }
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
   * Prompt a session using Claude Agent SDK (streaming version)
   *
   * Yields each assistant message as it arrives from the Agent SDK.
   * This enables progressive UI updates.
   *
   * @param sessionId - Session to prompt
   * @param prompt - User prompt
   * @returns Async generator yielding assistant messages with SDK session ID
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string
  ): AsyncGenerator<{
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    agentSessionId?: string;
  }> {
    const result = await this.setupQuery(sessionId, prompt, true);

    // Collect and yield assistant messages progressively
    console.log('📥 Receiving messages from Agent SDK...');
    let messageCount = 0;
    let capturedAgentSessionId: string | undefined;

    for await (const msg of result) {
      messageCount++;
      console.log(`   [Message ${messageCount}] type: ${msg.type}`);

      // Capture SDK session_id from first message that has it
      if (!capturedAgentSessionId && 'session_id' in msg && msg.session_id) {
        capturedAgentSessionId = msg.session_id;
        console.log(`   🔑 Captured Agent SDK session_id: ${capturedAgentSessionId}`);
      }

      if (msg.type === 'assistant') {
        const contentBlocks = this.processContentBlocks(msg.message?.content, messageCount);
        const toolUses = this.extractToolUses(contentBlocks);

        console.log(`   [Message ${messageCount}] Yielding assistant message (progressive update)`);

        // Yield this message immediately for progressive UI update
        yield {
          content: contentBlocks,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
          agentSessionId: capturedAgentSessionId, // Include SDK session_id with first message
        };
      } else if (msg.type === 'result') {
        console.log(`   [Message ${messageCount}] Final result received`);
      } else {
        console.log(
          `   [Message ${messageCount}] Unknown type:`,
          JSON.stringify(msg, null, 2).substring(0, 500)
        );
      }
    }

    console.log(`✅ Response complete: ${messageCount} total messages`);
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
    const result = await this.setupQuery(sessionId, prompt, false);

    // Collect response messages from async generator
    // IMPORTANT: Keep assistant messages SEPARATE (don't merge into one)
    console.log('📥 Receiving messages from Agent SDK...');
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
      console.log(`   [Message ${messageCount}] type: ${msg.type}`);

      if (msg.type === 'assistant') {
        const contentBlocks = this.processContentBlocks(msg.message?.content, messageCount);
        const toolUses = this.extractToolUses(contentBlocks);

        // Add as separate assistant message
        assistantMessages.push({
          content: contentBlocks,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
        });

        console.log(
          `   [Message ${messageCount}] Stored as assistant message #${assistantMessages.length}`
        );
      } else if (msg.type === 'result') {
        console.log(`   [Message ${messageCount}] Final result received`);
      } else {
        console.log(
          `   [Message ${messageCount}] Unknown type:`,
          JSON.stringify(msg, null, 2).substring(0, 500)
        );
      }
    }

    console.log(
      `✅ Response complete: ${assistantMessages.length} assistant messages, ${messageCount} total messages`
    );

    // TODO: Extract token counts from Agent SDK result metadata
    return {
      messages: assistantMessages,
      inputTokens: 0, // Agent SDK doesn't expose this yet
      outputTokens: 0,
    };
  }
}
