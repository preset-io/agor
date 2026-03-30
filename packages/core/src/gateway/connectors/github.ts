/**
 * GitHub Connector
 *
 * Polls the GitHub API for @mention comments on PRs/issues and posts
 * responses via the GitHub API. Uses GitHub App authentication
 * (installation tokens via @octokit/auth-app).
 *
 * Config shape (stored encrypted in gateway_channels.config):
 *   {
 *     app_id: number,
 *     private_key: string,           // PEM, encrypted at rest
 *     installation_id: number,
 *     webhook_secret?: string,       // encrypted at rest (webhook mode)
 *     owner: string,                 // org or user
 *     watch_repos?: string[],        // empty = all repos in installation
 *     poll_interval_ms?: number,     // default 15000
 *     require_mention?: boolean,     // default true
 *     mention_name?: string,         // app slug for @mention detection
 *     align_github_users?: boolean,  // map GitHub login → Agor user
 *     user_map?: Record<string, string>, // GitHub login → Agor email
 *   }
 *
 * Thread ID format: "owner/repo#number"
 *   e.g. "preset-io/agor#42"
 */

import type { Octokit } from '@octokit/rest';
import type { ChannelType } from '../../types/gateway';
import type { GatewayConnector, InboundMessage } from '../connector';

// ============================================================================
// Config & State Types
// ============================================================================

export interface GitHubChannelConfig {
  // ── Authentication (encrypted at rest) ──────────────────
  app_id: number;
  private_key: string; // PEM format
  installation_id: number;
  webhook_secret?: string; // only for webhook mode

  // ── Scope ───────────────────────────────────────────────
  owner: string; // org or user
  watch_repos?: string[]; // empty = all repos in installation

  // ── Polling ─────────────────────────────────────────────
  poll_interval_ms?: number; // default 15000

  // ── Trigger Behavior ───────────────────────────────────
  require_mention?: boolean; // default true
  mention_name?: string; // app slug for @mention detection (e.g. "agor")

  // ── User Alignment ─────────────────────────────────────
  align_github_users?: boolean;
  /** Explicit GitHub login → Agor email mapping (checked first, before email lookup) */
  user_map?: Record<string, string>;
}

/** Per-repo poll state for exactly-once processing */
interface RepoPollState {
  repo: string; // "owner/repo"
  lastPollAt: string; // ISO timestamp — used as `since` param
  lastEtag: string | null; // ETag for conditional requests (304 Not Modified)
  processedCommentIds: Set<number>; // Ring buffer for dedup
}

/** Max comment IDs to keep in the dedup set per repo */
const MAX_PROCESSED_IDS = 1000;

/** Default poll interval */
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Default mention keyword */
const DEFAULT_MENTION_NAME = 'agor';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a thread ID into owner, repo, and issue/PR number.
 *
 * Format: "owner/repo#number"
 * e.g. "preset-io/agor#42" → { owner: "preset-io", repo: "agor", number: 42 }
 */
export function parseThreadId(threadId: string): { owner: string; repo: string; number: number } {
  const match = threadId.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid GitHub thread ID format: "${threadId}" (expected "owner/repo#number")`
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

/**
 * Check if text contains an @mention outside of code blocks.
 *
 * Strips triple-backtick blocks and inline code spans first,
 * then tests for the mention pattern — so code-block mentions return false.
 */
function hasActiveMention(text: string, mentionName: string): boolean {
  // Strip triple-backtick blocks first (```...```), then inline code (`...`)
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  // GitHub mentions are @name (not <@ID> like Slack)
  const pattern = new RegExp(`@${escapeRegex(mentionName)}\\b`, 'i');
  return pattern.test(stripped);
}

/**
 * Strip @mention from text, returning the cleaned message body.
 */
function stripMention(text: string, mentionName: string): string {
  const pattern = new RegExp(`@${escapeRegex(mentionName)}\\s*`, 'gi');
  return text.replace(pattern, '').trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Add a comment ID to the dedup set, evicting oldest if over capacity.
 * Simple approach: convert to array, slice, rebuild set.
 */
function addToRingBuffer(set: Set<number>, id: number): void {
  set.add(id);
  if (set.size > MAX_PROCESSED_IDS) {
    // Evict oldest entries (Sets iterate in insertion order)
    const arr = [...set];
    const toRemove = arr.slice(0, arr.length - MAX_PROCESSED_IDS);
    for (const old of toRemove) {
      set.delete(old);
    }
  }
}

// ============================================================================
// GitHubConnector
// ============================================================================

export class GitHubConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'github';

  private config: GitHubChannelConfig;
  private octokit: Octokit | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollStates = new Map<string, RepoPollState>();
  private polling = false;

  constructor(config: Record<string, unknown>) {
    this.config = config as unknown as GitHubChannelConfig;

    if (!this.config.app_id) {
      throw new Error('GitHub connector requires app_id in config');
    }
    if (!this.config.private_key) {
      throw new Error('GitHub connector requires private_key in config');
    }
    if (!this.config.installation_id) {
      throw new Error('GitHub connector requires installation_id in config');
    }
    if (!this.config.owner) {
      throw new Error('GitHub connector requires owner in config');
    }
  }

  /**
   * Get an authenticated Octokit instance for the GitHub App installation.
   *
   * Uses @octokit/auth-app to automatically manage installation tokens
   * (creates them on first use, refreshes when expired).
   */
  private async getOctokit(): Promise<Octokit> {
    if (this.octokit) return this.octokit;

    // Dynamic imports — @octokit packages may not be installed yet.
    // Structured so the code compiles without the packages present.
    const { Octokit: OctokitClass } = await import('@octokit/rest');
    const { createAppAuth } = await import('@octokit/auth-app');

    this.octokit = new OctokitClass({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.app_id,
        privateKey: this.config.private_key,
        installationId: this.config.installation_id,
      },
    });

    return this.octokit;
  }

  /**
   * Resolve the list of repos to poll.
   *
   * If watch_repos is set, uses those (prefixed with owner).
   * Otherwise, lists all repos accessible to the installation.
   */
  private async resolveRepos(): Promise<string[]> {
    if (this.config.watch_repos && this.config.watch_repos.length > 0) {
      return this.config.watch_repos.map((repo) =>
        repo.includes('/') ? repo : `${this.config.owner}/${repo}`
      );
    }

    // List all repos accessible to this installation (paginated)
    const octokit = await this.getOctokit();
    const repos: string[] = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.apps.listReposAccessibleToInstallation({
        per_page: 100,
        page,
      });
      repos.push(...data.repositories.map((r: { full_name: string }) => r.full_name));
      if (repos.length >= data.total_count || data.repositories.length < 100) break;
      page++;
    }
    return repos;
  }

  /**
   * Get or create poll state for a repo.
   */
  private getRepoPollState(repo: string): RepoPollState {
    let state = this.pollStates.get(repo);
    if (!state) {
      state = {
        repo,
        lastPollAt: new Date().toISOString(),
        lastEtag: null,
        processedCommentIds: new Set(),
      };
      this.pollStates.set(repo, state);
    }
    return state;
  }

  /**
   * Poll a single repo for new comments with @mentions.
   *
   * Uses `since` parameter + ETag caching for efficiency.
   * Returns new InboundMessages for the callback.
   */
  private async pollRepo(repo: string): Promise<InboundMessage[]> {
    const state = this.getRepoPollState(repo);
    const octokit = await this.getOctokit();
    const [owner, repoName] = repo.split('/');
    const mentionName = this.config.mention_name ?? DEFAULT_MENTION_NAME;
    const requireMention = this.config.require_mention ?? true;

    const messages: InboundMessage[] = [];

    try {
      // Fetch issue/PR comments since last poll
      const headers: Record<string, string> = {};
      if (state.lastEtag) {
        headers['if-none-match'] = state.lastEtag;
      }

      const response = await octokit.issues.listCommentsForRepo({
        owner,
        repo: repoName,
        since: state.lastPollAt,
        sort: 'created',
        direction: 'asc',
        per_page: 100,
        headers,
      });

      // Update ETag for next request
      const etag = response.headers.etag;
      if (etag) {
        state.lastEtag = etag;
      }

      for (const comment of response.data) {
        // Skip if already processed (dedup)
        if (state.processedCommentIds.has(comment.id)) {
          continue;
        }

        // Skip bot's own comments (avoid loops)
        if (comment.user?.type === 'Bot') {
          addToRingBuffer(state.processedCommentIds, comment.id);
          continue;
        }

        const body = comment.body ?? '';

        // Check for @mention if required
        if (requireMention && !hasActiveMention(body, mentionName)) {
          addToRingBuffer(state.processedCommentIds, comment.id);
          continue;
        }

        // Extract issue/PR number from the comment's issue_url
        // issue_url looks like: https://api.github.com/repos/owner/repo/issues/42
        const issueUrlMatch = comment.issue_url?.match(/\/issues\/(\d+)$/);
        if (!issueUrlMatch) {
          console.warn(`[github] Could not extract issue number from comment ${comment.id}`);
          addToRingBuffer(state.processedCommentIds, comment.id);
          continue;
        }
        const issueNumber = parseInt(issueUrlMatch[1], 10);

        // Build thread ID
        const threadId = `${owner}/${repoName}#${issueNumber}`;

        // ── Instant Feedback ──────────────────────────────────
        // React with 👀 so the user knows the bot saw their mention
        try {
          await octokit.reactions.createForIssueComment({
            owner,
            repo: repoName,
            comment_id: comment.id,
            content: 'eyes',
          });
        } catch (err) {
          console.warn(`[github] Failed to add 👀 reaction to comment ${comment.id}:`, err);
        }

        // Post a "Processing..." comment that will be edited with the final response
        let processingCommentId: number | undefined;
        try {
          const { data: processingComment } = await octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: issueNumber,
            body: '⏳ Processing...',
          });
          processingCommentId = processingComment.id;
          // Mark our own processing comment as processed so we don't re-ingest it
          addToRingBuffer(state.processedCommentIds, processingComment.id);
        } catch (err) {
          console.warn(`[github] Failed to post processing comment on ${threadId}:`, err);
        }

        // Strip mention from body
        const text = requireMention ? stripMention(body, mentionName) : body;

        // Resolve user identity for alignment
        // NOTE: user_map lookup is done in the gateway (not here) because the gateway
        // reads fresh channel config from DB on every message. The connector's this.config
        // is set at construction time and would go stale if user_map is updated in the UI.
        const githubLogin = comment.user?.login;
        let githubUserEmail: string | undefined;

        if (this.config.align_github_users && githubLogin) {
          // Fetch GitHub user's public email (used by gateway tier-2 alignment)
          try {
            const { data: ghUser } = await octokit.users.getByUsername({
              username: githubLogin,
            });
            if (ghUser.email) {
              githubUserEmail = ghUser.email;
            }
          } catch (err) {
            console.warn(`[github] Failed to fetch user profile for ${githubLogin}:`, err);
          }
        }

        messages.push({
          threadId,
          text,
          userId: githubLogin ?? 'unknown',
          timestamp: comment.created_at,
          metadata: {
            comment_id: comment.id,
            github_user: githubLogin,
            github_user_url: comment.user?.html_url,
            issue_number: issueNumber,
            repo_full_name: repo,
            comment_url: comment.html_url,
            ...(processingCommentId ? { processing_comment_id: processingCommentId } : {}),
            ...(this.config.align_github_users ? { align_github_users: true } : {}),
            ...(githubUserEmail ? { github_user_email: githubUserEmail } : {}),
          },
        });

        addToRingBuffer(state.processedCommentIds, comment.id);
      }

      // Update last poll timestamp
      state.lastPollAt = new Date().toISOString();
    } catch (error: unknown) {
      // 304 Not Modified — nothing new, this is expected and cheap
      if (isHttpError(error, 304)) {
        return messages;
      }

      console.error(`[github] Poll error for ${repo}:`, error);
      // Don't update lastPollAt on error — retry from same point next cycle
    }

    return messages;
  }

  /**
   * Start the poll loop.
   *
   * Each tick polls all watched repos for new @mention comments.
   */
  async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
    console.log('[github] startListening called');

    // Validate we can authenticate
    const octokit = await this.getOctokit();
    try {
      const { data: installation } = await octokit.apps.getInstallation({
        installation_id: this.config.installation_id,
      });
      console.log(
        `[github] Authenticated as installation ${this.config.installation_id} on ${(installation.account && 'login' in installation.account ? installation.account.login : undefined) ?? 'unknown'}`
      );
    } catch (error) {
      console.error('[github] Failed to validate installation:', error);
      throw new Error(
        'GitHub App authentication failed — check app_id, private_key, and installation_id'
      );
    }

    // Resolve repos to watch
    const repos = await this.resolveRepos();
    console.log(`[github] Watching ${repos.length} repos:`, repos);

    // Initialize poll state for each repo
    for (const repo of repos) {
      this.getRepoPollState(repo);
    }

    const intervalMs = this.config.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
    console.log(`[github] Starting poll loop (interval: ${intervalMs}ms)`);

    // Run one poll immediately
    await this.pollTick(repos, callback);

    // Then start the interval
    this.pollTimer = setInterval(() => {
      void this.pollTick(repos, callback);
    }, intervalMs);
  }

  /**
   * Single poll tick — polls all repos and emits messages.
   * Guarded against overlapping ticks.
   */
  private async pollTick(repos: string[], callback: (msg: InboundMessage) => void): Promise<void> {
    if (this.polling) {
      console.warn('[github] Poll tick skipped (previous tick still running)');
      return;
    }

    this.polling = true;
    try {
      for (const repo of repos) {
        const messages = await this.pollRepo(repo);
        for (const msg of messages) {
          callback(msg);
        }
      }
    } catch (error) {
      console.error('[github] Poll tick error:', error);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Stop the poll loop and save state.
   */
  async stopListening(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
    console.log('[github] Poll loop stopped');
    // Future: persist pollStates to DB for restart recovery
  }

  /**
   * Post or edit a comment on a PR/issue.
   *
   * If `metadata.edit_comment_id` is set, edits that comment instead of
   * creating a new one. This is used to replace the "Processing..." comment
   * with the final agent response.
   */
  async sendMessage(req: {
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { owner, repo, number: issueNumber } = parseThreadId(req.threadId);
    const octokit = await this.getOctokit();
    const editCommentId = req.metadata?.edit_comment_id as number | undefined;

    if (editCommentId) {
      // Edit existing comment (the "Processing..." comment → final response)
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: editCommentId,
        body: req.text,
      });
      return String(editCommentId);
    }

    // Create new comment
    const { data } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: req.text,
    });

    return String(data.id);
  }

  /**
   * GitHub natively supports markdown — pass through with no conversion.
   */
  formatMessage(markdown: string): string {
    return markdown;
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Type guard for HTTP errors with a status code (Octokit throws RequestError).
 */
function isHttpError(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: number }).status === status
  );
}
