/**
 * Gateway Context Formatting
 *
 * Produces a human-readable context block that is prepended to inbound
 * messages so the agent knows where the message originated (platform,
 * channel, sender). The block is visible in the Agor UI conversation view.
 *
 * Uses blockquote (`>`) syntax to avoid markdown rendering issues —
 * `---` delimiters are interpreted as setext headings by streamdown
 * when they follow text without a blank line.
 */

import type { ChannelType } from '../types/gateway';

/**
 * Contextual metadata about an inbound gateway message.
 *
 * All fields except `platform` are optional — the formatter degrades
 * gracefully when information is unavailable.
 */
export interface GatewayContext {
  platform: ChannelType;
  channelName?: string; // '#eng-backend', 'DM', repo name, etc.
  channelKind?: string; // 'channel', 'DM', 'group DM', 'PR', 'issue'
  userName?: string; // Display name of the sender
  userHandle?: string; // @handle (GitHub login, Slack display name fallback)
  userEmail?: string; // If available (for user alignment context)
  /** Extra platform-specific lines (e.g. PR title, issue number) */
  extras?: string[];
}

/** Human-readable platform labels */
const PLATFORM_LABELS: Record<string, string> = {
  slack: 'Slack',
  discord: 'Discord',
  github: 'GitHub',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

/**
 * Format a gateway context block to prepend to a prompt.
 *
 * Returns an empty string when the context would add no useful information
 * (e.g. platform-only with no channel/user details).
 *
 * Output format (blockquote to avoid setext heading issues):
 * ```
 * > 📡 **Message via Slack**
 * > Channel: #eng-backend
 * > From: Max (max@preset.io)
 *
 * ```
 */
export function formatGatewayContext(ctx: GatewayContext): string {
  const label = PLATFORM_LABELS[ctx.platform] ?? ctx.platform;
  const lines: string[] = [];

  lines.push(`> 📡 **Message via ${label}**`);

  // Channel / location line
  if (ctx.channelName) {
    const kindLabel = ctx.channelKind === 'DM' ? 'DM with' : (ctx.channelKind ?? 'Channel');
    lines.push(`> ${kindLabel}: ${ctx.channelName}`);
  } else if (ctx.channelKind === 'DM') {
    lines.push('> DM');
  }

  // Extra lines (PR title, issue number, repo, etc.)
  if (ctx.extras) {
    for (const extra of ctx.extras) {
      lines.push(`> ${extra}`);
    }
  }

  // From line
  const fromParts: string[] = [];
  if (ctx.userName) {
    fromParts.push(ctx.userName);
  } else if (ctx.userHandle) {
    fromParts.push(ctx.userHandle);
  }

  if (fromParts.length > 0) {
    // Add email in parentheses if available and different from name
    if (ctx.userEmail && ctx.userEmail !== fromParts[0]) {
      fromParts.push(`(${ctx.userEmail})`);
    }
    lines.push(`> From: ${fromParts.join(' ')}`);
  }

  // Only emit the block if we have at least one detail line
  // beyond the header "📡 Message via X"
  if (lines.length <= 1) {
    return '';
  }

  return `${lines.join('\n')}\n\n`;
}
