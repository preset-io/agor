/**
 * Gateway Service
 *
 * Core routing service that orchestrates message routing between
 * messaging platforms and Agor sessions. Custom service (not DrizzleService)
 * since it orchestrates across multiple repositories and services.
 */

import {
  type Database,
  GatewayChannelRepository,
  MCPServerRepository,
  ThreadSessionMapRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { GatewayConnector, GatewayContext, InboundMessage } from '@agor/core/gateway';
import {
  formatGatewayContext,
  getConnector,
  hasConnector,
  parseGitHubThreadId,
} from '@agor/core/gateway';
import { resolveModelConfig } from '@agor/core/models';
import type {
  AgenticToolName,
  ChannelType,
  GatewayChannel,
  MCPServerID,
  MessageSource,
  Session,
  SessionID,
  User,
  UserID,
} from '@agor/core/types';
import { getDefaultPermissionMode, SessionStatus } from '@agor/core/types';

/**
 * Inbound message data (platform → session)
 */
interface PostMessageData {
  channel_key: string;
  thread_id: string;
  text: string;
  user_name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Inbound message response
 */
interface PostMessageResult {
  success: boolean;
  sessionId: string;
  created: boolean;
}

/**
 * Outbound routing data (session → platform)
 */
interface RouteMessageData {
  session_id: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Outbound routing response
 */
interface RouteMessageResult {
  routed: boolean;
  channelType?: string;
}

/**
 * Check if a channel has the required config for its connector to listen.
 * Slack requires `app_token` (Socket Mode); GitHub requires `app_id` + `private_key` + `installation_id` (polling).
 */
function hasListeningConfig(channel: GatewayChannel): boolean {
  const config = channel.config as Record<string, unknown>;
  switch (channel.channel_type) {
    case 'slack':
      return !!config.app_token;
    case 'github':
      return !!(
        config.app_id &&
        config.private_key &&
        config.installation_id &&
        (config.watch_repos as string[] | undefined)?.length
      );
    default:
      return false;
  }
}

/**
 * Build the initial prompt for a new GitHub-routed session.
 *
 * Provides minimal routing metadata (repo, PR/issue number, URL, commenter)
 * plus behavioral instructions for the GitHub channel. The agent needs to
 * know that only its last message will be posted as a PR/issue comment.
 *
 * Everything else — what to do, how to review, whether to fetch diffs — is
 * the responsibility of the assistant's instructions configured by the admin.
 */
function buildGitHubInitialPrompt(
  threadId: string,
  text: string,
  metadata?: Record<string, unknown>
): string {
  try {
    const { owner, repo, number } = parseGitHubThreadId(threadId);
    const url = `https://github.com/${owner}/${repo}/issues/${number}`;
    const userName = metadata?.github_user ? `@${metadata.github_user}` : 'a user';
    const commentUrl = metadata?.comment_url ?? url;

    return [
      `[GitHub] ${userName} mentioned you on ${owner}/${repo}#${number}`,
      `${commentUrl}`,
      ``,
      text,
      ``,
      `---`,
      `## GitHub Channel Behavior`,
      ``,
      `This session was triggered from a GitHub mention. Important behavior notes:`,
      ``,
      `- Your **last message** will be automatically posted as a comment on the GitHub issue/PR`,
      `- Only the final message is posted — intermediate messages are visible in the Agor UI only`,
      `- Keep your final response concise and GitHub-appropriate (markdown formatted)`,
      `- If you need to delegate work to another session, mention the session link in your response`,
      `- The comment will appear as the GitHub App bot identity, not as any human user`,
      `- Be thorough in your work, then provide a clear final summary`,
    ].join('\n');
  } catch {
    return text;
  }
}

/**
 * Build a GatewayContext from channel + inbound message data.
 *
 * Maps platform-specific metadata fields onto the platform-agnostic
 * GatewayContext interface used by formatGatewayContext().
 */
function buildGatewayContext(channel: GatewayChannel, data: PostMessageData): GatewayContext {
  const meta = data.metadata ?? {};

  switch (channel.channel_type) {
    case 'slack': {
      const slackChannelType = meta.channel_type as string | undefined;
      const isDM = slackChannelType === 'im';
      const isMpim = slackChannelType === 'mpim';

      let channelName: string | undefined;
      let channelKind: string | undefined;

      if (isDM) {
        channelKind = 'DM';
      } else if (isMpim) {
        channelKind = 'Group DM';
        channelName = (meta.slack_channel_name as string) ?? undefined;
      } else {
        channelKind = 'Channel';
        const name = meta.slack_channel_name as string | undefined;
        channelName = name ? `#${name}` : undefined;
      }

      return {
        platform: 'slack',
        channelName,
        channelKind,
        userName: (meta.slack_user_name as string) ?? undefined,
        userEmail: (meta.slack_user_email as string) ?? undefined,
      };
    }

    case 'github': {
      const repo = meta.repo_full_name as string | undefined;
      const issueNumber = meta.issue_number as number | undefined;
      const githubUser = meta.github_user as string | undefined;
      const commentUrl = meta.comment_url as string | undefined;

      const extras: string[] = [];
      if (repo) extras.push(`Repo: ${repo}`);
      if (issueNumber) {
        extras.push(`Issue/PR: #${issueNumber}`);
      }
      if (commentUrl) extras.push(`Comment: ${commentUrl}`);

      return {
        platform: 'github',
        channelName: repo,
        userHandle: githubUser ? `@${githubUser}` : undefined,
        userEmail: (meta.github_user_email as string) ?? undefined,
        extras,
      };
    }

    default:
      // Generic fallback for future platforms
      return {
        platform: channel.channel_type as ChannelType,
        userName: data.user_name,
      };
  }
}

/**
 * Gateway routing service
 */
export class GatewayService {
  private channelRepo: GatewayChannelRepository;
  private threadMapRepo: ThreadSessionMapRepository;
  private usersRepo: UsersRepository;

  private mcpServerRepo: MCPServerRepository;
  private userTokenRepo: UserMCPOAuthTokenRepository;
  private app: Application;

  /** Active Socket Mode listeners keyed by channel ID */
  private activeListeners = new Map<string, GatewayConnector>();

  /**
   * In-memory flag: true when at least one gateway channel exists.
   * Allows routeMessage() to skip the DB lookup entirely when the
   * gateway feature is not in use (the common case for most instances).
   * Updated on startup and whenever channels are created/deleted.
   */
  private hasActiveChannels = false;

  /**
   * GitHub message buffer: keyed by session_id, stores the latest message text.
   * For GitHub channels, we don't send every assistant message in real-time
   * (unlike Slack). Instead, we buffer and only send the last message when
   * the session turn completes (goes idle). Each new message overwrites the
   * previous one — only the final message matters.
   */
  private githubMessageBuffer = new Map<string, string>();

  constructor(db: Database, app: Application) {
    this.channelRepo = new GatewayChannelRepository(db);
    this.threadMapRepo = new ThreadSessionMapRepository(db);
    this.usersRepo = new UsersRepository(db);

    this.mcpServerRepo = new MCPServerRepository(db);
    this.userTokenRepo = new UserMCPOAuthTokenRepository(db);
    this.app = app;
  }

  /**
   * Refresh the in-memory hasActiveChannels flag.
   * Called at startup and should be called when channels are created/deleted.
   */
  async refreshChannelState(): Promise<void> {
    const channels = await this.channelRepo.findAll();
    this.hasActiveChannels = channels.some((ch) => ch.enabled);
    console.log(
      `[gateway] refreshChannelState: found ${channels.length} channels, ${channels.filter((ch) => ch.enabled).length} enabled`
    );
  }

  /**
   * Send a debug/system message to the platform thread (fire-and-forget).
   * Useful for giving the user visibility into what's happening.
   */
  private sendDebugMessage(channel: GatewayChannel, threadId: string, text: string): void {
    // Skip debug messages for GitHub channels — the "Processing..." comment
    // already serves as the status indicator and gets edited with the final response.
    // Posting debug messages as separate comments clutters the issue thread.
    if (channel.channel_type === 'github') return;

    if (!hasConnector(channel.channel_type as ChannelType)) return;
    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);
      connector
        .sendMessage({ threadId, text: `_[system] ${text}_` })
        .catch((err) => console.warn('[gateway] Debug message failed:', err));
    } catch {
      // Ignore — debug messages are best-effort
    }
  }

  /**
   * Inbound routing: platform → session
   *
   * Authenticates via channel_key, looks up or creates a session
   * for the given thread, and sends the prompt to the session.
   */
  async create(data: PostMessageData): Promise<PostMessageResult> {
    // 1. Authenticate via channel_key
    const channel = await this.channelRepo.findByKey(data.channel_key);
    if (!channel) {
      throw new Error('Invalid channel_key');
    }

    if (!channel.enabled) {
      throw new Error('Channel is disabled');
    }

    // 2. Look up existing thread mapping
    const existingMapping = await this.threadMapRepo.findByChannelAndThread(
      channel.id,
      data.thread_id
    );

    // 3. Cross-channel ownership check (MUST happen before any sendDebugMessage calls).
    // If this thread is owned by a DIFFERENT gateway channel on the same daemon,
    // silently drop the message — we must not interfere with another gateway's thread.
    // This covers all rejection paths: unmapped thread replies, user alignment failures, etc.
    if (!existingMapping) {
      const otherChannelMapping = await this.threadMapRepo.findByThread(data.thread_id);
      if (otherChannelMapping) {
        console.log(
          `[gateway] IGNORED: Thread ${data.thread_id} owned by channel ${otherChannelMapping.channel_id.substring(0, 8)}, not ours (${channel.id.substring(0, 8)}). Silently dropping.`
        );
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    // 4. Reject unmapped thread replies that came through without mention.
    // This prevents unauthorized session creation when users reply to random threads
    // without explicitly mentioning the bot. Only threads where the bot was mentioned
    // (creating a mapping) can continue conversations without mentions.
    // IMPORTANT: Silently drop — do NOT send a debug message. These are normal messages
    // in threads that have nothing to do with Agor. Sending a visible rejection would
    // cause the bot to spam every active thread in the channel.
    if (!existingMapping && data.metadata?.requires_mapping_verification) {
      // Use debug level — this fires for every non-Agor thread reply in monitored
      // channels and would create excessive log noise at info level.
      console.debug(
        `[gateway] IGNORED: Thread reply without mention in unmapped thread: channel=${channel.id.substring(0, 8)}, thread=${data.thread_id}`
      );
      return {
        success: false,
        sessionId: '',
        created: false,
      };
    }

    // 5. Resolve effective user (platform user alignment or channel owner fallback)
    //
    // Alignment flags are checked FIRST: when alignment is active, the channel
    // owner ("run as") is NOT used — user is resolved entirely via alignment
    // (or rejected). This prevents privilege escalation where any org member
    // with @mention access would inherit the channel owner's permissions.
    const usersService = this.app.service('users') as {
      get: (id: string) => Promise<User>;
    };
    const channelConfig = channel.config as Record<string, unknown>;
    const alignSlackUsers =
      channelConfig.align_slack_users === true || data.metadata?.align_slack_users === true;
    const alignGitHubUsers =
      channelConfig.align_github_users === true || data.metadata?.align_github_users === true;

    // Only fetch and use channel owner when NO alignment is active.
    // When alignment is ON, agor_user_id may be empty (the "Post messages as"
    // field is hidden in the UI), so we must not fetch it unconditionally.
    let user: User = null as unknown as User;
    if (!alignSlackUsers && !alignGitHubUsers) {
      if (!channel.agor_user_id) {
        const errMsg =
          'Channel configuration error: no "Post messages as" user set. An admin needs to edit the channel and select a user, or enable user alignment.';
        console.error(
          `[gateway] Channel "${channel.name}" has no agor_user_id and alignment is OFF. Cannot process message.`
        );
        this.sendDebugMessage(channel, data.thread_id, errMsg);
        // For GitHub: edit the Processing comment with the error
        if (channel.channel_type === 'github' && data.metadata?.processing_comment_id) {
          try {
            const connector = getConnector(channel.channel_type as ChannelType, channel.config);
            await connector.sendMessage({
              threadId: data.thread_id,
              text: `⚠️ ${errMsg}`,
              metadata: { edit_comment_id: data.metadata.processing_comment_id },
            });
          } catch (err) {
            console.warn('[gateway] Failed to post config error comment:', err);
          }
        }
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
      user = await usersService.get(channel.agor_user_id);
    }

    // --- Slack user alignment ---
    if (alignSlackUsers) {
      if (data.metadata?.slack_user_email && typeof data.metadata.slack_user_email === 'string') {
        const email = data.metadata.slack_user_email.toLowerCase().trim();
        const matchedUser = await this.usersRepo.findByEmail(email);

        if (matchedUser) {
          console.log(
            `[gateway] Slack user aligned: ${email} → Agor user ${matchedUser.user_id.substring(0, 8)} (${matchedUser.name || matchedUser.email})`
          );
          user = await usersService.get(matchedUser.user_id);
        } else {
          console.log(`[gateway] Slack user alignment failed: no Agor user with email ${email}`);
          this.sendDebugMessage(
            channel,
            data.thread_id,
            `User ${email} doesn't have an Agor account. Ask an admin to create an account with this email, or disable user alignment.`
          );
          return {
            success: false,
            sessionId: '',
            created: false,
          };
        }
      } else {
        // Alignment is enabled but email couldn't be resolved (missing
        // users:read.email scope, Slack API error, or no email on profile).
        // Reject instead of silently falling back to channel owner.
        console.log(
          `[gateway] Slack user alignment failed: could not resolve email for Slack user ${data.user_name ?? 'unknown'} (thread=${data.thread_id})`
        );
        this.sendDebugMessage(
          channel,
          data.thread_id,
          "Couldn't resolve your Slack identity. The bot may be missing the `users:read.email` scope, or your Slack profile has no email. Ask an admin to check the bot's scopes."
        );
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    // --- GitHub user alignment ---
    // 3-tier resolution: user_map → GitHub email → reject.
    // Never falls back to channel owner — unmapped users are rejected.
    if (alignGitHubUsers && !alignSlackUsers) {
      const githubLogin = data.metadata?.github_user as string | undefined;
      let resolved = false;

      // Tier 1: Explicit user_map (GitHub login → Agor email)
      // Read user_map from fresh channel.config (NOT from connector metadata,
      // which can be stale since the connector holds config from construction time).
      const userMap = channelConfig.user_map as Record<string, string> | undefined;
      const mappedEmail =
        githubLogin && userMap?.[githubLogin] ? userMap[githubLogin].toLowerCase().trim() : null;

      if (mappedEmail) {
        const matchedUser = await this.usersRepo.findByEmail(mappedEmail);
        if (matchedUser) {
          console.log(
            `[gateway] GitHub user aligned via user_map: ${githubLogin} → ${mappedEmail} → Agor user ${matchedUser.user_id.substring(0, 8)}`
          );
          user = await usersService.get(matchedUser.user_id);
          resolved = true;
        } else {
          console.warn(
            `[gateway] user_map entry ${githubLogin} → ${mappedEmail} but no Agor user with that email`
          );
        }
      }

      // Tier 2: GitHub public email → Agor user email match
      if (!resolved) {
        const githubEmail =
          data.metadata?.github_user_email && typeof data.metadata.github_user_email === 'string'
            ? data.metadata.github_user_email.toLowerCase().trim()
            : null;

        if (githubEmail) {
          const matchedUser = await this.usersRepo.findByEmail(githubEmail);
          if (matchedUser) {
            console.log(
              `[gateway] GitHub user aligned via email: ${githubLogin} (${githubEmail}) → Agor user ${matchedUser.user_id.substring(0, 8)}`
            );
            user = await usersService.get(matchedUser.user_id);
            resolved = true;
          }
        }
      }

      // Tier 3: Reject — no silent fallback to channel owner
      if (!resolved) {
        console.log(
          `[gateway] GitHub user alignment failed: no Agor mapping for ${githubLogin ?? 'unknown'} (thread=${data.thread_id})`
        );
        // Edit the Processing comment with rejection message (if we have one)
        if (data.metadata?.processing_comment_id) {
          try {
            const connector = getConnector(channel.channel_type as ChannelType, channel.config);
            await connector.sendMessage({
              threadId: data.thread_id,
              text: `⚠️ @${githubLogin ?? 'unknown'} — your GitHub account isn't linked to an Agor user. Ask an admin to add a \`user_map\` entry for your GitHub login, or set a public email on your GitHub profile that matches your Agor account.`,
              metadata: { edit_comment_id: data.metadata.processing_comment_id },
            });
          } catch (err) {
            console.warn('[gateway] Failed to post rejection comment:', err);
          }
        }
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    let sessionId: string;
    let created = false;
    let mcpAuthWarning: string | undefined;

    // Resolve agentic config: channel config > user defaults > system defaults
    const agenticConfig = channel.agentic_config;
    const agenticTool: AgenticToolName = (agenticConfig?.agent as AgenticToolName) ?? 'claude-code';
    const userDefaults = user.default_agentic_config?.[agenticTool];
    const permissionMode =
      agenticConfig?.permissionMode ??
      userDefaults?.permissionMode ??
      getDefaultPermissionMode(agenticTool);
    const modelConfig = agenticConfig?.modelConfig ?? userDefaults?.modelConfig;

    if (existingMapping) {
      // Existing thread → existing session
      sessionId = existingMapping.session_id;

      // Touch timestamps
      await this.threadMapRepo.updateLastMessage(existingMapping.id);

      // Update mapping metadata with new processing_comment_id if present.
      // Each follow-up @mention creates a new "Processing..." comment, and
      // the flush needs the latest comment ID to edit the right one.
      if (data.metadata?.processing_comment_id) {
        const updatedMetadata = {
          ...((existingMapping.metadata as Record<string, unknown>) ?? {}),
          processing_comment_id: data.metadata.processing_comment_id,
        };
        await this.threadMapRepo.updateMetadata(existingMapping.id, updatedMetadata);
      }

      this.sendDebugMessage(
        channel,
        data.thread_id,
        `Received follow-up, routing to session ${sessionId.substring(0, 8)}...`
      );
    } else {
      // New thread → create session via FeathersJS service
      const sessionsService = this.app.service('sessions') as unknown as {
        create: (data: Partial<Session>) => Promise<Session>;
        setMCPServers: (sessionId: SessionID, serverIds: string[], label: string) => Promise<void>;
      };

      this.sendDebugMessage(
        channel,
        data.thread_id,
        `Creating new ${agenticTool} session (${permissionMode} mode)...`
      );

      // Build custom_context with gateway metadata + platform-specific fields
      const gatewaySource: Record<string, unknown> = {
        channel_id: channel.id,
        channel_name: channel.name,
        channel_type: channel.channel_type,
        thread_id: data.thread_id,
      };

      // Add GitHub-specific metadata for richer context
      if (channel.channel_type === 'github') {
        try {
          const parsed = parseGitHubThreadId(data.thread_id);
          gatewaySource.github_repo = `${parsed.owner}/${parsed.repo}`;
          gatewaySource.github_issue_number = parsed.number;
          gatewaySource.github_thread_id = data.thread_id;
        } catch {
          // Non-fatal — thread ID might not match expected format
        }
        // Flag for downstream consumers: only the last message is posted to GitHub
        gatewaySource.last_message_only = true;
      }

      const session = await sessionsService.create({
        title: data.text.substring(0, 100),
        description: data.text,
        worktree_id: channel.target_worktree_id,
        created_by: user.user_id,
        // Stamp session with creator's unix_username for executor impersonation.
        // Normally set by the setSessionUnixUsername hook, but that hook skips
        // internal calls (no provider). Gateway sessions are internal, so we
        // must set it explicitly. When user alignment is active, this uses the
        // aligned user's unix_username; otherwise the channel owner's.
        unix_username: user.unix_username ?? null,
        status: SessionStatus.IDLE,
        agentic_tool: agenticTool,
        permission_config: { mode: permissionMode },
        model_config: resolveModelConfig(modelConfig),
        tasks: [],
        // Denormalized gateway metadata (immutable snapshot at creation time)
        // Avoids N+1 lookups when rendering board cards
        custom_context: {
          gateway_source: gatewaySource,
        },
      });

      sessionId = session.session_id;
      created = true;

      // Attach MCP servers from channel agentic config (reuses sessions service logic)
      const mcpServerIds = agenticConfig?.mcpServerIds;
      if (mcpServerIds && mcpServerIds.length > 0) {
        await sessionsService.setMCPServers(
          session.session_id as SessionID,
          mcpServerIds,
          'gateway'
        );

        // Check which MCP servers are not authenticated for this user
        const unauthedMcpNames: string[] = [];
        for (const serverId of mcpServerIds) {
          try {
            const server = await this.mcpServerRepo.findById(serverId);
            if (server?.auth?.type === 'oauth') {
              const oauthMode = server.auth.oauth_mode || 'per_user';
              // Unified token store — shared rows key on user_id=NULL, per_user on the caller's id.
              const tokenUserId = oauthMode === 'shared' ? null : (user.user_id as UserID);
              // Count a row with a valid refresh_token as "authed" even if the
              // access_token is expired — the inject hook will JIT-refresh it
              // before handing it to the executor. This avoids spurious
              // "not authenticated" warnings for users who are one refresh away.
              const row = await this.userTokenRepo.getToken(tokenUserId, serverId as MCPServerID);
              const accessValid = !!(
                row?.oauth_access_token &&
                (!row.oauth_token_expires_at || row.oauth_token_expires_at > new Date())
              );
              const refreshable = !!row?.oauth_refresh_token;
              if (!accessValid && !refreshable) {
                unauthedMcpNames.push(server.display_name || server.name);
              }
            }
          } catch {
            // Non-fatal — skip auth check for this server
          }
        }

        // Track unauthed MCP names so the warning can be prepended to the initial prompt
        if (unauthedMcpNames.length > 0) {
          mcpAuthWarning = `[System notice: The following MCP servers are not authenticated for this user and will be unavailable: ${unauthedMcpNames.join(', ')}. The agent will not have access to these tools.]`;
          console.log(`[gateway] MCP auth warning for: ${unauthedMcpNames.join(', ')}`);
        }
      }

      // Create thread → session mapping
      await this.threadMapRepo.create({
        channel_id: channel.id,
        thread_id: data.thread_id,
        session_id: session.session_id,
        worktree_id: channel.target_worktree_id,
        status: 'active',
        metadata: data.metadata ?? null,
      });

      // Get session URL from created session (URL is added by after hook)
      // Fetch the session to get the URL property
      let sessionUrl: string | null = null;
      try {
        const sessionsService = this.app.service('sessions') as {
          get: (id: string, params?: { user: User }) => Promise<Session & { url?: string | null }>;
        };
        const sessionWithUrl = await sessionsService.get(sessionId, { user });
        sessionUrl = sessionWithUrl.url || null;
      } catch (error) {
        console.warn('[gateway] Failed to fetch session URL:', error);
      }

      // Send debug message with session URL
      const sessionIdShort = sessionId.substring(0, 8);
      const message = sessionUrl
        ? `Session created: ${sessionUrl}`
        : `Session ${sessionIdShort} created, sending prompt to agent...`;

      this.sendDebugMessage(channel, data.thread_id, message);

      // For GitHub channels: edit the "Processing..." comment to include the session link.
      // The processing_comment_id was stored in inbound metadata by the GitHub connector.
      if (channel.channel_type === 'github' && data.metadata?.processing_comment_id) {
        try {
          const connector = getConnector(channel.channel_type as ChannelType, channel.config);
          const processingText = sessionUrl
            ? `⏳ Processing... [View session](${sessionUrl})`
            : `⏳ Processing in session \`${sessionId.substring(0, 8)}\`...`;
          await connector.sendMessage({
            threadId: data.thread_id,
            text: processingText,
            metadata: { edit_comment_id: data.metadata.processing_comment_id },
          });
        } catch (err) {
          console.warn('[gateway] Failed to update processing comment with session URL:', err);
        }
      }
    }

    // Touch channel last_message_at
    await this.channelRepo.updateLastMessage(channel.id);

    // 4. Send prompt via /sessions/:id/prompt — it handles queue-vs-execute internally
    //    (auto-queues when session is busy or has queued items, executes when idle)
    try {
      const promptService = this.app.service('/sessions/:id/prompt') as {
        create: (
          data: { prompt: string; permissionMode?: string; messageSource?: MessageSource },
          params: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      };

      // For new GitHub sessions, wrap the prompt with repository/PR context
      // so the agent knows where it's operating. Follow-up messages (existing
      // mapping) are sent as-is since the session already has context.
      let promptText = data.text;
      if (created && channel.channel_type === 'github') {
        promptText = buildGitHubInitialPrompt(data.thread_id, data.text, data.metadata);
      }

      // Prepend gateway context block so the agent knows the message source.
      // Applied to ALL messages (initial + follow-up) since each message may
      // come from a different user in a shared channel.
      // Skip for initial GitHub messages — buildGitHubInitialPrompt() already
      // includes repo/issue/user context and adding both would be redundant.
      const skipContext = created && channel.channel_type === 'github';
      if (!skipContext) {
        const gatewayCtx = buildGatewayContext(channel, data);
        const contextPrefix = formatGatewayContext(gatewayCtx);
        if (contextPrefix) {
          promptText = contextPrefix + promptText;
        }
      }

      // Prepend MCP auth warning to the initial prompt so the agent is aware
      if (created && mcpAuthWarning) {
        promptText = `${mcpAuthWarning}\n\n${promptText}`;
      }

      // Internal call: pass user, omit provider to bypass auth hooks
      // Mark message source as 'gateway' so it won't be echoed back to the platform
      const response = await promptService.create(
        { prompt: promptText, permissionMode, messageSource: 'gateway' },
        { route: { id: sessionId }, user }
      );

      if (response.queued) {
        console.log(
          `[gateway] Message queued for session ${sessionId.substring(0, 8)} at position ${response.queue_position}`
        );
        this.sendDebugMessage(
          channel,
          data.thread_id,
          `Session is busy, message queued at position ${response.queue_position}`
        );
      } else {
        console.log(
          `[gateway] Prompt sent to session ${sessionId.substring(0, 8)} via /sessions/:id/prompt`
        );
      }
    } catch (error) {
      console.error('[gateway] Failed to send prompt to session:', error);
      this.sendDebugMessage(channel, data.thread_id, `Error sending prompt: ${error}`);
    }

    return {
      success: true,
      sessionId,
      created,
    };
  }

  /**
   * Outbound routing: session → platform
   *
   * Looks up session in thread_session_map. If no mapping exists,
   * returns a cheap no-op. Uses platform connectors to send messages.
   */
  async routeMessage(data: RouteMessageData): Promise<RouteMessageResult> {
    // Fast path: skip DB lookup entirely when no channels are configured
    if (!this.hasActiveChannels) {
      return { routed: false };
    }

    // Look up session in thread_session_map
    const mapping = await this.threadMapRepo.findBySession(data.session_id);

    if (!mapping) {
      // No mapping → cheap no-op (session is not gateway-connected)
      return { routed: false };
    }

    console.log(
      `[gateway] Found mapping: channel=${mapping.channel_id.substring(0, 8)}, thread=${mapping.thread_id}`
    );

    const channel = await this.channelRepo.findById(mapping.channel_id);

    if (!channel || !channel.enabled) {
      return { routed: false };
    }

    // Check if we have a connector for this channel type
    if (!hasConnector(channel.channel_type as ChannelType)) {
      console.warn(`[gateway] No connector for channel type: ${channel.channel_type}`);
      return { routed: false };
    }

    // Touch timestamps
    await this.threadMapRepo.updateLastMessage(mapping.id);
    await this.channelRepo.updateLastMessage(channel.id);

    // For GitHub channels, buffer the message instead of sending immediately.
    // Only the last message will be posted when the session goes idle (via flushGitHubBuffer).
    // This prevents noisy intermediate messages from cluttering PR threads.
    if (channel.channel_type === 'github') {
      this.githubMessageBuffer.set(data.session_id, data.message);
      console.log(
        `[gateway] Buffered GitHub message for session ${data.session_id.substring(0, 8)} (${data.message.length} chars)`
      );
      return { routed: true, channelType: 'github' };
    }

    // Non-GitHub channels (e.g. Slack): send immediately
    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);

      const text = connector.formatMessage ? connector.formatMessage(data.message) : data.message;

      await connector.sendMessage({
        threadId: mapping.thread_id,
        text,
        metadata: data.metadata,
      });

      console.log(
        `[gateway] Routed message to ${channel.channel_type} thread ${mapping.thread_id}`
      );
    } catch (error) {
      console.error(`[gateway] Failed to route message to ${channel.channel_type}:`, error);
      return { routed: false, channelType: channel.channel_type };
    }

    return {
      routed: true,
      channelType: channel.channel_type,
    };
  }

  /**
   * Flush the GitHub message buffer for a session.
   *
   * Called when a session transitions to idle (turn complete). Posts the
   * last buffered message as a PR/issue comment by editing the "Processing..."
   * comment. If no buffered message exists, this is a no-op.
   */
  async flushGitHubBuffer(sessionId: string): Promise<void> {
    const bufferedMessage = this.githubMessageBuffer.get(sessionId);
    if (!bufferedMessage) {
      return; // No buffered message — nothing to flush
    }

    // Remove from buffer immediately (prevent double-flush)
    this.githubMessageBuffer.delete(sessionId);

    // Look up session → thread mapping
    const mapping = await this.threadMapRepo.findBySession(sessionId);
    if (!mapping) {
      console.warn(
        `[gateway] flushGitHubBuffer: no thread mapping for session ${sessionId.substring(0, 8)}`
      );
      return;
    }

    const channel = await this.channelRepo.findById(mapping.channel_id);
    if (!channel || !channel.enabled || channel.channel_type !== 'github') {
      return;
    }

    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);

      const text = connector.formatMessage
        ? connector.formatMessage(bufferedMessage)
        : bufferedMessage;

      // Edit the "Processing..." comment with the final response
      const outboundMetadata: Record<string, unknown> = {};
      if (
        mapping.metadata &&
        typeof (mapping.metadata as Record<string, unknown>).processing_comment_id === 'number'
      ) {
        outboundMetadata.edit_comment_id = (
          mapping.metadata as Record<string, unknown>
        ).processing_comment_id;
      }

      await connector.sendMessage({
        threadId: mapping.thread_id,
        text,
        metadata: outboundMetadata,
      });

      console.log(
        `[gateway] Flushed GitHub buffer for session ${sessionId.substring(0, 8)} → ${mapping.thread_id} (${bufferedMessage.length} chars)`
      );
    } catch (error) {
      // Re-queue the message so it can be retried on next flush (e.g. session
      // goes idle again, or daemon restarts). Without this, a transient GitHub
      // API error would permanently lose the agent's final response.
      this.githubMessageBuffer.set(sessionId, bufferedMessage);
      console.error(
        `[gateway] Failed to flush GitHub buffer for session ${sessionId.substring(0, 8)} (re-queued):`,
        error
      );
    }
  }

  /**
   * Start Socket Mode listeners for all enabled channels that support it.
   * Called once at daemon startup. Inbound messages are routed through
   * the gateway's create() method (same path as webhook POST).
   */
  async startListeners(): Promise<void> {
    const channels = await this.channelRepo.findAll();
    const eligible = channels.filter(
      (ch) => ch.enabled && hasConnector(ch.channel_type as ChannelType) && hasListeningConfig(ch)
    );

    if (eligible.length === 0) {
      console.log('[gateway] No channels with listener config (Socket Mode / polling)');
      return;
    }

    for (const channel of eligible) {
      await this.startChannelListener(channel);
    }
  }

  /**
   * Start or stop a Socket Mode listener for a single channel based on its enabled state
   * (public wrapper for hook usage)
   */
  async startListenerForChannel(channelId: string): Promise<void> {
    const channel = await this.channelRepo.findById(channelId);
    if (!channel) {
      console.warn(`[gateway] Cannot manage listener: channel ${channelId} not found`);
      return;
    }

    // If channel is disabled, stop the listener
    if (!channel.enabled) {
      await this.stopChannelListener(channelId);
      console.log(`[gateway] Stopped listener for disabled channel ${channel.name}`);
      return;
    }

    // If no connector or missing listener config, stop any existing listener
    if (!hasConnector(channel.channel_type as ChannelType)) {
      console.warn(`[gateway] No connector for channel type: ${channel.channel_type}`);
      await this.stopChannelListener(channelId);
      return;
    }
    if (!hasListeningConfig(channel)) {
      console.log(
        `[gateway] Skipping listener for channel ${channel.name} (missing listener config)`
      );
      await this.stopChannelListener(channelId);
      return;
    }

    // Stop existing listener first so config changes are picked up.
    // startChannelListener() is a no-op if a listener already exists,
    // so we must tear down the old one before creating a new connector
    // with the updated config (e.g. enable_channels toggled).
    if (this.activeListeners.has(channelId)) {
      console.log(
        `[gateway] Restarting listener for channel "${channel.name}" to pick up config changes`
      );
      await this.stopChannelListener(channelId);
    }

    // Start with fresh config
    await this.startChannelListener(channel);
  }

  /**
   * Stop a Socket Mode listener for a single channel
   */
  async stopChannelListener(channelId: string): Promise<void> {
    const connector = this.activeListeners.get(channelId);
    if (!connector) {
      return; // Not listening
    }

    // Always remove from activeListeners so a fresh start can proceed,
    // even if stopListening() throws (e.g. socket already closed).
    this.activeListeners.delete(channelId);

    try {
      if (connector.stopListening) {
        await connector.stopListening();
      }
      console.log(`[gateway] Listener stopped for channel ${channelId.substring(0, 8)}`);
    } catch (error) {
      // Old socket may still be alive — duplicate inbound messages are possible
      // until the next daemon restart. See: listener lifecycle serialization (tech debt).
      console.error(
        `[gateway] Error stopping listener for ${channelId} (old socket may still be alive):`,
        error
      );
    }
  }

  /**
   * Start a Socket Mode listener for a single channel
   */
  private async startChannelListener(channel: GatewayChannel): Promise<void> {
    if (this.activeListeners.has(channel.id)) {
      return; // Already listening
    }

    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);

      if (!connector.startListening) {
        return; // Connector doesn't support listening
      }

      const callback = (msg: InboundMessage) => {
        this.create({
          channel_key: channel.channel_key,
          thread_id: msg.threadId,
          text: msg.text,
          user_name: msg.userId,
          metadata: msg.metadata,
        }).catch((error) => {
          console.error(
            `[gateway] Failed to process inbound message for channel ${channel.name}:`,
            error
          );
        });
      };

      await connector.startListening(callback);
      this.activeListeners.set(channel.id, connector);
      console.log(`[gateway] Socket Mode listener started for channel "${channel.name}"`);
    } catch (error) {
      console.error(`[gateway] Failed to start listener for channel "${channel.name}":`, error);
    }
  }

  /**
   * Stop all active listeners (called on shutdown)
   */
  async stopListeners(): Promise<void> {
    for (const [channelId, connector] of this.activeListeners) {
      try {
        if (connector.stopListening) {
          await connector.stopListening();
        }
        console.log(`[gateway] Listener stopped for channel ${channelId.substring(0, 8)}`);
      } catch (error) {
        console.error(`[gateway] Error stopping listener for ${channelId}:`, error);
      }
    }
    this.activeListeners.clear();
  }
}

/**
 * Service factory function
 */
export function createGatewayService(db: Database, app: Application): GatewayService {
  return new GatewayService(db, app);
}
