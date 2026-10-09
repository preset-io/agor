/**
 * Classify verified Teams lifecycle activities that make stored conversation
 * addresses unusable: app uninstall, bot removal, team or channel deletion.
 */

import type { TeamsAddressRevocationReason } from '../../types/gateway';

export interface TeamsAddressRevocationEvent {
  /** Base conversation ids (no `;messageid=` suffix) whose addresses are revoked. */
  conversationIds: string[];
  /** Team thread id when the event covers every channel of a team. */
  teamId: string | null;
  reason: TeamsAddressRevocationReason;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function baseConversationId(id: string | null): string | null {
  if (!id) return null;
  const marker = id.indexOf(';messageid=');
  return marker >= 0 ? id.slice(0, marker) : id;
}

/** Return the addresses a verified lifecycle activity revokes, or null for anything else. */
export function teamsAddressRevocationFromActivity(
  raw: Record<string, unknown>,
  appId: string
): TeamsAddressRevocationEvent | null {
  const type = text(raw.type);
  const channelData = record(raw.channelData);
  const teamId = text(record(channelData.team).id);
  const conversationId = baseConversationId(text(record(raw.conversation).id));
  const scope = (reason: TeamsAddressRevocationReason): TeamsAddressRevocationEvent => ({
    conversationIds: conversationId ? [conversationId] : [],
    teamId,
    reason,
  });
  if (type === 'installationUpdate') {
    return text(raw.action) === 'remove' ? scope('bot_removed') : null;
  }
  if (type !== 'conversationUpdate') return null;
  const eventType = text(channelData.eventType);
  if (eventType === 'teamDeleted' || eventType === 'teamHardDeleted') {
    return scope('conversation_deleted');
  }
  if (eventType === 'channelDeleted') {
    const channelId = baseConversationId(text(record(channelData.channel).id));
    return channelId
      ? { conversationIds: [channelId], teamId: null, reason: 'conversation_deleted' }
      : null;
  }
  const removed = Array.isArray(raw.membersRemoved) ? raw.membersRemoved : [];
  const botRemoved = removed.some((member) => {
    const id = text(record(member).id);
    return !!appId && (id === appId || id === `28:${appId}`);
  });
  return botRemoved ? scope('bot_removed') : null;
}
