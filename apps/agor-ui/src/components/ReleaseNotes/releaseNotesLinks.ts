import type { ReleaseNoteDTO, User } from '@agor-live/client';
import { RELEASE_NOTE_CTA_TOKENS, shortId } from '@agor-live/client';
import { readLocalStorageJson } from '../../hooks/localStorageJson';
import { recentBoardsStorageKey } from '../../hooks/useRecentBoards';

/** The board the user is on or last visited, else their main board. */
export function currentOrRecentBoardId(user: User | null | undefined): string | undefined {
  const recent = readLocalStorageJson<unknown>(recentBoardsStorageKey(user?.user_id), []);
  const first = Array.isArray(recent) ? recent.find((id) => typeof id === 'string') : undefined;
  return first ?? user?.preferences?.mainBoardId;
}

/**
 * Resolve the board tokens in an in-app CTA path. Null when a token has no
 * board to point at, so the CTA is hidden instead of leading nowhere. The
 * daemon only serves relative paths; the leading-slash check is a second guard.
 */
export function resolveCtaPath(path: string | null, user: User | null | undefined): string | null {
  if (!path?.startsWith('/') || path.startsWith('//')) return null;
  const boards: Record<string, string | undefined> = {
    [RELEASE_NOTE_CTA_TOKENS.currentBoard]: currentOrRecentBoardId(user),
    [RELEASE_NOTE_CTA_TOKENS.mainBoard]: user?.preferences?.mainBoardId,
  };
  let resolved = path;
  for (const [token, boardId] of Object.entries(boards)) {
    if (!resolved.includes(token)) continue;
    if (!boardId) return null;
    resolved = resolved.replaceAll(token, shortId(boardId));
  }
  return resolved;
}

/** Most items an "Ask my teammate" prompt carries, newest first. */
const ASK_TEAMMATE_MAX_ITEMS = 20;

export function buildAskTeammatePrompt(notes: ReleaseNoteDTO[]): string {
  const lines = notes
    .flatMap((note) =>
      note.items.map((item) => {
        const docs = item.docs_url ? ` Docs: ${item.docs_url}` : '';
        return `- ${item.title} (${note.published_at.slice(0, 10)}): ${item.agent_brief}${docs}`;
      })
    )
    .slice(0, ASK_TEAMMATE_MAX_ITEMS);
  return [
    'Agor shipped these updates recently:',
    '',
    ...lines,
    '',
    'Look at my boards, branches and recent work in Agor and tell me which of these updates would help me, and why. Suggest concrete next steps for the useful ones. Do not change anything without asking me first.',
  ].join('\n');
}
