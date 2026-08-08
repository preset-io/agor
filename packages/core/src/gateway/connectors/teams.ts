/**
 * Microsoft Teams Connector
 *
 * Sends messages via Bot Framework SDK and listens for inbound messages
 * via an HTTP webhook endpoint.
 *
 * Config shape (stored encrypted in gateway_channels.config):
 *   {
 *     app_id: string,              // Azure Bot Registration App ID
 *     app_password: string,        // Azure Bot Registration App Secret
 *     tenant_id?: string,          // Single-tenant restriction (optional)
 *     webhook_port?: number,       // Port for Bot Framework endpoint (default: 3978)
 *     webhook_path?: string,       // Webhook path (default: /api/messages)
 *     require_mention?: boolean,   // Require @mention in channels (default: true)
 *     allow_thread_replies_without_mention?: boolean, // Allow thread replies without @mention (default: true)
 *   }
 *
 * Thread ID format: "{conversationId}|{activityId}"
 *   e.g. "19:abc123@thread.tacv2|1234567890"
 *
 * Uses last-pipe split because conversationId can contain colons and other special chars.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';

import type {
  BotFrameworkAdapter as BotFrameworkAdapterType,
  ConversationReference,
  TurnContext as TurnContextType,
} from 'botbuilder';

import type { ChannelType } from '../../types/gateway';
import type { GatewayConnector, GatewayInboundCallback } from '../connector';

interface TeamsConfig {
  app_id: string;
  app_password: string;
  tenant_id?: string;
  webhook_port?: number;
  webhook_path?: string;
  require_mention?: boolean;
  allow_thread_replies_without_mention?: boolean;
}

type BotBuilderModule = typeof import('botbuilder');

function loadBotBuilder(): BotBuilderModule {
  try {
    return createRequire(import.meta.url)('botbuilder') as BotBuilderModule;
  } catch (error) {
    throw new Error(
      'Microsoft Teams support requires the optional botbuilder package. ' +
        'Install it alongside Agor, then retry. See https://agor.live/guide/extended-install#agentic-tools',
      { cause: error }
    );
  }
}

/**
 * Parse a composite thread ID into conversationId + activityId.
 *
 * Format: "{conversationId}|{activityId}" — uses last pipe as delimiter
 * because conversationId can contain special characters.
 *
 * e.g. "19:abc123@thread.tacv2|1234567890" →
 *   { conversationId: "19:abc123@thread.tacv2", activityId: "1234567890" }
 */
export function parseThreadId(threadId: string): {
  conversationId: string;
  activityId: string;
} {
  const lastPipe = threadId.lastIndexOf('|');
  if (lastPipe === -1) {
    throw new Error(
      `Invalid Teams thread ID format: "${threadId}" (expected "{conversationId}|{activityId}")`
    );
  }

  const conversationId = threadId.substring(0, lastPipe);
  const activityId = threadId.substring(lastPipe + 1);

  if (!conversationId || !activityId) {
    throw new Error(
      `Invalid Teams thread ID format: "${threadId}" (expected "{conversationId}|{activityId}")`
    );
  }

  return { conversationId, activityId };
}

/**
 * Strip `<at>BotName</at>` mention tags from Teams message text.
 *
 * Teams wraps @mentions in `<at>...</at>` tags. This removes them
 * (case-insensitive) and cleans up surrounding whitespace.
 */
export function stripMention(text: string, botName: string): string {
  // Escape regex special chars in bot name
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<at>${escaped}</at>\\s*`, 'gi');
  return text.replace(pattern, '').trim();
}

/**
 * Check if a `<at>BotName</at>` mention appears outside code blocks.
 *
 * Same strategy as Slack's hasActiveMention — strip code blocks first,
 * then test for the mention pattern.
 */
function hasActiveMention(text: string, botName: string): boolean {
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<at>${escaped}</at>`, 'i');
  return pattern.test(stripped);
}

/**
 * Strip HTML tags from text. Teams sometimes wraps messages in HTML.
 */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

/**
 * Extract the actual user text from a Teams quoted-reply message.
 *
 * When a user replies to a specific message in a 1:1 (personal) chat, Teams
 * prepends the quoted message content to `activity.text` (making it garbled),
 * but provides the structured data in an HTML attachment like:
 *
 * ```html
 * <blockquote itemtype="http://schema.skype.com/Reply" ...>
 *   ...quoted message preview...
 * </blockquote>
 * <p>actual user message</p>
 * ```
 *
 * This function checks for that pattern and returns only the user's text.
 * Returns null if no quoted-reply attachment is found.
 */
export function extractQuotedReplyText(
  attachments: Array<{ contentType?: string; content?: string }> | undefined
): string | null {
  if (!attachments) return null;

  for (const attachment of attachments) {
    if (attachment.contentType !== 'text/html' || !attachment.content) continue;
    if (!attachment.content.includes('schema.skype.com/Reply')) continue;

    // Extract everything after the closing </blockquote> tag
    const afterQuote = attachment.content.split('</blockquote>').pop();
    if (!afterQuote) continue;

    // Strip HTML tags to get plain text
    const text = stripHtmlTags(afterQuote).trim();
    if (text) return text;
  }

  return null;
}

/**
 * Wrap a Node.js ServerResponse to satisfy Bot Framework's WebResponse interface.
 *
 * Bot Framework expects `send()` and `status()` methods (Express-like),
 * but Node's raw HTTP ServerResponse doesn't have them.
 */
function wrapResponse(res: ServerResponse): ServerResponse & {
  status: (code: number) => ServerResponse;
  send: (body?: unknown) => void;
} {
  const wrapped = res as ServerResponse & {
    status: (code: number) => ServerResponse;
    send: (body?: unknown) => void;
  };

  wrapped.status = (code: number) => {
    res.statusCode = code;
    return res;
  };

  wrapped.send = (body?: unknown) => {
    if (body !== undefined && body !== null) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(bodyStr);
    } else {
      res.end();
    }
  };

  return wrapped;
}

export class TeamsConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'teams';

  private adapter: BotFrameworkAdapterType;
  private TurnContext: BotBuilderModule['TurnContext'];
  private config: TeamsConfig;
  private server: Server | null = null;

  /** Stored ConversationReferences for proactive messaging, keyed by threadId */
  private conversationRefs = new Map<string, Partial<ConversationReference>>();

  constructor(config: Record<string, unknown>) {
    this.config = config as unknown as TeamsConfig;

    if (!this.config.app_id) {
      throw new Error('Teams connector requires app_id in config');
    }
    if (!this.config.app_password) {
      throw new Error('Teams connector requires app_password in config');
    }

    const { BotFrameworkAdapter, TurnContext } = loadBotBuilder();
    this.TurnContext = TurnContext;
    this.adapter = new BotFrameworkAdapter({
      appId: this.config.app_id,
      appPassword: this.config.app_password,
      ...(this.config.tenant_id ? { channelAuthTenant: this.config.tenant_id } : {}),
    });
  }

  /**
   * Send a message to a Teams thread using a stored ConversationReference.
   *
   * Uses the proactive messaging pattern: look up the stored reference
   * from the inbound turn, then use adapter.continueConversation() to
   * send a message outside of a turn.
   */
  async sendMessage(req: {
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const ref = this.conversationRefs.get(req.threadId);
    if (!ref) {
      throw new Error(
        `No ConversationReference stored for thread ${req.threadId}. ` +
          'Cannot send proactive message before receiving an inbound message.'
      );
    }

    let sentActivityId = '';

    await this.adapter.continueConversation(ref, async (turnContext) => {
      const response = await turnContext.sendActivity(req.text);
      sentActivityId = response?.id ?? '';
    });

    return sentActivityId;
  }

  /**
   * Start listening for inbound messages via an HTTP webhook.
   *
   * Creates a lightweight HTTP server that receives Bot Framework activities
   * from Azure Bot Service, processes them, and calls the gateway callback.
   */
  async startListening(callback: GatewayInboundCallback): Promise<void> {
    const port = this.config.webhook_port ?? 3978;
    const path = this.config.webhook_path ?? '/api/messages';
    const requireMention = this.config.require_mention ?? true;
    const allowThreadRepliesWithoutMention =
      this.config.allow_thread_replies_without_mention ?? true;

    // Resolve bot name from adapter on first activity (lazy)
    let botName: string | null = null;

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only handle POST to the webhook path
      if (req.method !== 'POST' || req.url !== path) {
        res.statusCode = 404;
        res.end();
        return;
      }

      // Collect request body
      const bodyChunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
      req.on('end', () => {
        const bodyStr = Buffer.concat(bodyChunks).toString('utf-8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(bodyStr);
        } catch {
          res.statusCode = 400;
          res.end('Invalid JSON');
          return;
        }

        // Attach parsed body to request for Bot Framework adapter
        (req as IncomingMessage & { body: unknown }).body = body;

        this.adapter.processActivity(
          req as IncomingMessage & { body: unknown; headers: Record<string, string> },
          wrapResponse(res),
          async (turnContext: TurnContextType) => {
            const activity = turnContext.activity;

            // Only handle message activities
            if (activity.type !== 'message') {
              return;
            }

            // Skip bot's own messages to avoid loops
            if (activity.from?.id === this.config.app_id) {
              return;
            }

            // Store ConversationReference for proactive messaging
            const ref = this.TurnContext.getConversationReference(activity);

            // Resolve bot name from the first activity's recipient
            if (!botName && activity.recipient?.name) {
              botName = activity.recipient.name;
              console.log(`[teams] Bot name resolved: "${botName}"`);
            }

            // Determine conversation type
            const conversationType = (activity.conversation as unknown as Record<string, unknown>)
              ?.conversationType as string | undefined;
            const isPersonal = conversationType === 'personal';
            // In channels, replyToId indicates a thread reply to the root message.
            // In personal chats, replyToId indicates a quote-reply (not a separate thread).
            const isThreadReply = !isPersonal && !!activity.replyToId;

            // Build thread ID
            //
            // Personal (1:1) chats: use conversationId only. The entire DM
            // is one thread = one session. Every message in the same 1:1 chat
            // shares the same conversationId regardless of quotes/replies.
            //
            // Channel threads: use baseConversationId|rootMessageId. Teams
            // appends ";messageid=<rootTimestamp>" to conversation.id for
            // thread replies, so we strip that to normalize. The root message
            // ID comes from either the messageid parameter, replyToId, or
            // the activity's own ID.
            const rawConversationId = activity.conversation?.id ?? '';
            const replyToId = activity.replyToId;

            let threadId: string;
            if (isPersonal) {
              threadId = rawConversationId;
            } else {
              // Normalize: strip ";messageid=..." from conversation.id
              // Root messages: "19:channel@thread.tacv2"
              // Thread replies: "19:channel@thread.tacv2;messageid=<rootTimestamp>"
              let baseConversationId = rawConversationId;
              let messageIdFromConv: string | undefined;

              const msgIdIdx = rawConversationId.indexOf(';messageid=');
              if (msgIdIdx !== -1) {
                baseConversationId = rawConversationId.substring(0, msgIdIdx);
                messageIdFromConv = rawConversationId.substring(msgIdIdx + ';messageid='.length);
              }

              // Root message ID: prefer messageid from conversation.id, then
              // replyToId, then activity.id
              const rootId = messageIdFromConv ?? replyToId ?? activity.id ?? '';
              threadId = `${baseConversationId}|${rootId}`;
            }

            // Store reference for this thread (always update with latest activity)
            this.conversationRefs.set(threadId, ref);

            // Extract message text — check for quoted-reply first.
            // In 1:1 chats, replying to a message prepends the quoted content
            // to activity.text (garbled). The clean text is in the HTML attachment.
            const quotedReplyText = extractQuotedReplyText(
              activity.attachments as Array<{ contentType?: string; content?: string }> | undefined
            );
            let messageText = quotedReplyText ?? activity.text ?? '';

            // Check entities array for bot mentions and strip them.
            // Teams bot IDs in entities use format "28:<app_id>" or just "<app_id>",
            // so we check with .includes() rather than exact match.
            // Each mention entity has a `text` property containing the exact
            // "<at>Bot Name</at>" string used in activity.text — we remove that
            // exact string for reliable stripping regardless of display name.
            let hasMention = false;
            if (activity.entities) {
              for (const entity of activity.entities) {
                if (entity.type !== 'mention') continue;
                const mentioned = (entity as unknown as Record<string, unknown>).mentioned as
                  | Record<string, unknown>
                  | undefined;
                const mentionedId = (mentioned?.id as string) ?? '';
                const isBotMention =
                  mentionedId === this.config.app_id || mentionedId.includes(this.config.app_id);
                if (!isBotMention) continue;

                hasMention = true;
                // Remove the exact mention text from the message
                const mentionText = (entity as unknown as Record<string, unknown>).text as
                  | string
                  | undefined;
                if (mentionText && messageText.includes(mentionText)) {
                  messageText = messageText.replace(mentionText, '').trim();
                }
              }
            }

            // Fallback: also try stripping by known bot names if entities didn't cover it
            if (!hasMention) {
              const allBotNames = new Set<string>();
              if (botName) allBotNames.add(botName);
              if (activity.recipient?.name) allBotNames.add(activity.recipient.name);
              for (const name of allBotNames) {
                if (hasActiveMention(messageText, name)) {
                  hasMention = true;
                  messageText = stripMention(messageText, name);
                }
              }
            }

            // Clean up any remaining HTML tags Teams might inject
            messageText = stripHtmlTags(messageText).trim();

            if (!messageText) {
              return; // Empty after stripping
            }

            // Mention requirement for non-personal chats
            if (!isPersonal && requireMention) {
              if (!hasMention) {
                if (isThreadReply && allowThreadRepliesWithoutMention) {
                  // Allow thread replies without mention (same as Slack)
                } else {
                  return; // Skip — no mention in channel/group
                }
              }
            }

            // Extract user info from activity
            const userName = (activity.from as unknown as Record<string, unknown>)?.name as
              | string
              | undefined;
            const userAadObjectId = (activity.from as unknown as Record<string, unknown>)
              ?.aadObjectId as string | undefined;

            // Extract team/channel name if available
            const channelData = activity.channelData as Record<string, unknown> | undefined;
            const teamName = (channelData?.team as Record<string, unknown> | undefined)?.name as
              | string
              | undefined;
            const channelName = (channelData?.channel as Record<string, unknown> | undefined)
              ?.name as string | undefined;
            const tenantId = (channelData?.tenant as Record<string, unknown> | undefined)?.id as
              | string
              | undefined;

            // Teams is standalone-only today. Preserve its historical quick
            // Bot Framework acknowledgement rather than holding the webhook
            // open while Agor admits the prompt; PostgreSQL mode fails this
            // connector closed before startup.
            void Promise.resolve(
              callback({
                providerEventId: activity.id
                  ? `teams:activity:${rawConversationId}:${activity.id}`
                  : undefined,
                threadId,
                text: messageText,
                userId: activity.from?.id ?? 'unknown',
                timestamp: activity.timestamp?.toISOString() ?? new Date().toISOString(),
                metadata: {
                  teams_conversation_type: conversationType,
                  teams_channel_name: channelName,
                  teams_team_name: teamName,
                  teams_user_name: userName,
                  teams_user_aad_id: userAadObjectId,
                  teams_tenant_id: tenantId,
                  requires_mapping_verification: !hasMention && isThreadReply,
                },
              })
            ).catch((error) => console.error('[teams] Gateway callback failed:', error));
          }
        );
      });
    });

    return new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Server not created'));
        return;
      }
      this.server.on('error', (err) => {
        console.error(`[teams] HTTP server error:`, err);
        reject(err);
      });
      this.server.listen(port, () => {
        console.log(`[teams] Webhook server listening on port ${port} at ${path}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP webhook server
   */
  async stopListening(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server?.close(() => {
          console.log('[teams] Webhook server stopped');
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * Convert markdown to Teams-compatible format.
   *
   * Teams natively supports most markdown (bold, italic, code blocks, links, lists).
   * Main adjustments:
   * - Collapse <details>/<summary> blocks (not supported in Teams)
   * - Strip unsupported HTML tags
   */
  formatMessage(markdown: string): string {
    let text = markdown;

    // Collapse <details>/<summary> blocks into visible text
    text = text.replace(
      /<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/gi,
      (_match, summary: string, content: string) => {
        const summaryText = summary.trim();
        const contentText = content.trim();
        return `**${summaryText}**\n${contentText}`;
      }
    );

    // Strip remaining HTML tags (but preserve content inside them)
    text = stripHtmlTags(text);

    return text.trim();
  }
}
