import {
  matchSearchTokens,
  SEARCHABLE_FIELDS,
  type Session,
  tokenizeSearchQuery,
} from '@agor-live/client';
import { getTimeMs } from './entityTime';
import { getSessionDisplayTitle } from './sessionTitle';

export const SESSION_SORT_STORAGE_KEY = 'agor:session-sort';
export const SESSION_SEARCH_MIN_QUERY_LENGTH = 2;

export type SessionSort = 'recent' | 'oldest' | 'alpha';

export interface SearchSessionResult {
  session: Session;
  score: number;
}

export const SESSION_SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'alpha', label: 'A–Z' },
];

const SCORE_WEIGHTS = {
  TITLE_EXACT: 1000,
  TITLE_STARTS: 800,
  TITLE_PHRASE: 600,
  TITLE_ALL_WORDS: 400,
  TITLE_PARTIAL_WORDS: 200,
  DESC_PHRASE: 120,
  DESC_ALL_WORDS: 80,
  DESC_PARTIAL_WORDS: 40,
  TOOL_MATCH: 30,
  STATUS_ACTIVE: 20,
  STATUS_AWAITING: 15,
  RECENCY_MAX: 50,
} as const;

export function normalizeSessionQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function getSearchTerms(query: string, minLength = 1): string[] {
  return uniqueTerms(tokenizeSearchQuery(query).filter((part) => part.length >= minLength));
}

export function scoreSession(session: Session, query: string, now = Date.now()): number {
  const q = normalizeSessionQuery(query);
  if (!q) return 0;

  const words = getSearchTerms(q);
  const displayTitle = (session.title || session.description || '').toLowerCase();
  const desc = (session.description ?? '').toLowerCase();
  const tool = session.agentic_tool.toLowerCase();

  let score = 0;

  if (displayTitle === q) {
    score += SCORE_WEIGHTS.TITLE_EXACT;
  } else if (displayTitle.startsWith(q)) {
    score += SCORE_WEIGHTS.TITLE_STARTS;
  } else if (displayTitle.includes(q)) {
    score += SCORE_WEIGHTS.TITLE_PHRASE;
  } else {
    const matched = words.filter((word) => displayTitle.includes(word));
    if (matched.length === words.length) {
      score += SCORE_WEIGHTS.TITLE_ALL_WORDS;
    } else if (matched.length > 0) {
      score += Math.round(SCORE_WEIGHTS.TITLE_PARTIAL_WORDS * (matched.length / words.length));
    }
  }

  if (desc && desc !== displayTitle) {
    if (desc.includes(q)) {
      score += SCORE_WEIGHTS.DESC_PHRASE;
    } else {
      const matched = words.filter((word) => desc.includes(word));
      if (matched.length === words.length) {
        score += SCORE_WEIGHTS.DESC_ALL_WORDS;
      } else if (matched.length > 0) {
        score += Math.round(SCORE_WEIGHTS.DESC_PARTIAL_WORDS * (matched.length / words.length));
      }
    }
  }

  if (words.some((word) => tool.includes(word))) {
    score += SCORE_WEIGHTS.TOOL_MATCH;
  }

  // Boost only real matches. Status and recency should never make an unrelated
  // session appear in search results.
  if (score === 0) return 0;

  const updatedAt = getTimeMs(session, 'last_updated');
  if (Number.isFinite(updatedAt)) {
    const ageDays = Math.max(0, (now - updatedAt) / 86_400_000);
    score += Math.round(SCORE_WEIGHTS.RECENCY_MAX * Math.exp(-ageDays));
  }

  if (session.status === 'running' || session.status === 'stopping') {
    score += SCORE_WEIGHTS.STATUS_ACTIVE;
  } else if (session.status === 'awaiting_permission') {
    score += SCORE_WEIGHTS.STATUS_AWAITING;
  }

  return score;
}

export function searchSessions(
  sessions: Session[],
  query: string,
  options: { now?: number } = {}
): SearchSessionResult[] {
  const q = normalizeSessionQuery(query);
  if (!isSessionSearchActive(q)) return [];
  const tokens = tokenizeSearchQuery(q);

  return sessions
    .filter((session) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.session(session)))
    .map((session) => ({ session, score: scoreSession(session, q, options.now) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || compareByRecent(a.session, b.session));
}

export function isSessionSearchActive(query: string): boolean {
  return normalizeSessionQuery(query).length >= SESSION_SEARCH_MIN_QUERY_LENGTH;
}

export function sessionToolMatches(session: Session, query: string): boolean {
  const terms = getSearchTerms(query);
  if (terms.length === 0) return false;
  const tool = session.agentic_tool.toLowerCase();
  return terms.some((term) => tool.includes(term));
}

export function getMatchSnippet(text: string, query: string, contextLen = 60): string | null {
  if (!text || !query.trim()) return null;

  const lower = text.toLowerCase();
  const candidates = [normalizeSessionQuery(query), ...getSearchTerms(query)].filter(Boolean);
  let pos = -1;
  let matchLength = 0;

  for (const candidate of candidates.sort((a, b) => b.length - a.length)) {
    const idx = lower.indexOf(candidate);
    if (idx !== -1) {
      pos = idx;
      matchLength = candidate.length;
      break;
    }
  }

  if (pos === -1) return null;

  const start = Math.max(0, pos - contextLen);
  const end = Math.min(text.length, pos + Math.max(matchLength, 10) + contextLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';

  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function sortSessions(sessions: Session[], sort: SessionSort): Session[] {
  const copy = [...sessions];

  switch (sort) {
    case 'oldest':
      return copy.sort(compareByOldest);
    case 'alpha':
      return copy.sort(compareByTitle);
    default:
      return copy.sort(compareByRecent);
  }
}

function compareByRecent(a: Session, b: Session): number {
  return getTimeMs(b, 'last_updated') - getTimeMs(a, 'last_updated');
}

function compareByOldest(a: Session, b: Session): number {
  return getTimeMs(a, 'last_updated') - getTimeMs(b, 'last_updated');
}

function compareByTitle(a: Session, b: Session): number {
  return getSessionDisplayTitle(a, { includeAgentFallback: true }).localeCompare(
    getSessionDisplayTitle(b, { includeAgentFallback: true }),
    undefined,
    { sensitivity: 'base' }
  );
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    if (!seen.has(term)) {
      seen.add(term);
      unique.push(term);
    }
  }
  return unique;
}
