import type { AgorClient, BoardID } from '@agor-live/client';

export interface AssistantWelcomeNoteInput {
  client: AgorClient | null;
  boardId: BoardID | string;
  assistantName: string;
  assistantEmoji?: string | null;
}

/**
 * Adds the initial markdown note on an assistant board when missing.
 *
 * The daemon renders the bundled static Handlebars template server-side via a
 * boards custom method. Keeping the browser out of this render path avoids
 * importing Handlebars into the UI bundle, where CSP blocks its `new Function`
 * compilation strategy.
 *
 * Best-effort: failure should not block assistant/board creation.
 */
export async function ensureAssistantWelcomeNote({
  client,
  boardId,
  assistantName,
  assistantEmoji,
}: AssistantWelcomeNoteInput): Promise<void> {
  if (!client || !boardId) return;

  try {
    await client.service('boards').ensureAssistantWelcomeNote({
      boardId,
      assistantName,
      assistantEmoji,
    });
  } catch (error) {
    console.warn('Failed to create assistant welcome note:', error);
  }
}
