import type {
  ChatCollection,
  ChatCollectionPreferences,
  SessionID,
  UserPreferences,
} from '@agor-live/client';

export const MAX_TEAMMATE_CHAT_COLLECTIONS = 12;
export const MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION = 50;
/** Keep the default picker useful on large instances without hiding search results. */
export const RECENT_TEAMMATE_CHAT_SESSION_LIMIT = 50;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Treat persisted preferences as untrusted input and return a small canonical shape. */
export function readTeammateChatPreferences(
  preferences: UserPreferences | null | undefined
): ChatCollectionPreferences {
  const raw = preferences?.chat_collections;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.collections)) {
    return { collections: [] };
  }

  const ids = new Set<string>();
  const collections: ChatCollection[] = [];
  for (const candidate of raw.collections.slice(0, MAX_TEAMMATE_CHAT_COLLECTIONS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as unknown as Record<string, unknown>;
    const collectionId = asNonEmptyString(record.collection_id);
    const name = asNonEmptyString(record.name);
    if (!collectionId || !name || ids.has(collectionId) || !Array.isArray(record.session_ids)) {
      continue;
    }
    ids.add(collectionId);
    const sessionIds = Array.from(
      new Set(record.session_ids.filter((id): id is SessionID => typeof id === 'string' && !!id))
    ).slice(0, MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION);
    collections.push({
      collection_id: collectionId,
      name,
      session_ids: sessionIds,
    });
  }
  return { collections };
}

export function withTeammateChatPreferences(
  preferences: UserPreferences | null | undefined,
  teammateChats: ChatCollectionPreferences
): UserPreferences {
  return {
    ...(preferences ?? {}),
    chat_collections: readTeammateChatPreferences({ chat_collections: teammateChats }),
  };
}

export function createTeammateChatCollection(
  collectionId: string,
  name = 'Chat collection',
  sessionIds: SessionID[] = []
): ChatCollection {
  return readTeammateChatPreferences({
    chat_collections: {
      collections: [{ collection_id: collectionId, name, session_ids: sessionIds }],
    },
  }).collections[0];
}
