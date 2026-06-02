import type { Session } from '@agor-live/client';
import { theme } from 'antd';
import { getSessionDisplayTitle } from './sessionTitle';

export const SESSION_SORT_STORAGE_KEY = 'agor:session-sort';

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
  STATUS_RUNNING: 20,
  STATUS_AWAITING: 15,
  RECENCY_MAX: 50,
} as const;

export function scoreSession(session: Session, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const words = q.split(/\s+/).filter(Boolean);
  const displayTitle = getSessionDisplayTitle(session, { includeAgentFallback: false }).toLowerCase();
  const desc = (session.description ?? '').toLowerCase();
  const tool = session.agentic_tool.toLowerCase();

  let score = 0;

  // Title scoring
  if (displayTitle === q) {
    score += SCORE_WEIGHTS.TITLE_EXACT;
  } else if (displayTitle.startsWith(q)) {
    score += SCORE_WEIGHTS.TITLE_STARTS;
  } else if (displayTitle.includes(q)) {
    score += SCORE_WEIGHTS.TITLE_PHRASE;
  } else {
    const matched = words.filter((w) => displayTitle.includes(w));
    if (matched.length === words.length) {
      score += SCORE_WEIGHTS.TITLE_ALL_WORDS;
    } else if (matched.length > 0) {
      score += Math.round(SCORE_WEIGHTS.TITLE_PARTIAL_WORDS * (matched.length / words.length));
    }
  }

  // Description scoring (skip if description is empty or same as title)
  if (desc && desc !== displayTitle) {
    if (desc.includes(q)) {
      score += SCORE_WEIGHTS.DESC_PHRASE;
    } else {
      const matched = words.filter((w) => desc.includes(w));
      if (matched.length === words.length) {
        score += SCORE_WEIGHTS.DESC_ALL_WORDS;
      } else if (matched.length > 0) {
        score += Math.round(SCORE_WEIGHTS.DESC_PARTIAL_WORDS * (matched.length / words.length));
      }
    }
  }

  // Tool match
  if (words.some((w) => tool.includes(w))) {
    score += SCORE_WEIGHTS.TOOL_MATCH;
  }

  // Recency bonus — only added when there is already a match (score > 0)
  if (score > 0) {
    const ageDays = (Date.now() - new Date(session.last_updated).getTime()) / 86_400_000;
    score += Math.round(SCORE_WEIGHTS.RECENCY_MAX * Math.exp(-ageDays));
  }

  // Status bonus for actively running sessions
  if (session.status === 'running') score += SCORE_WEIGHTS.STATUS_RUNNING;
  else if (session.status === 'awaiting_permission') score += SCORE_WEIGHTS.STATUS_AWAITING;

  return score;
}

export function getMatchSnippet(text: string, query: string, contextLen = 60): string | null {
  if (!text || !query.trim()) return null;

  const q = query.trim().toLowerCase();
  const lower = text.toLowerCase();

  let pos = lower.indexOf(q);
  if (pos === -1) {
    for (const w of q.split(/\s+/).filter(Boolean)) {
      const idx = lower.indexOf(w);
      if (idx !== -1) { pos = idx; break; }
    }
  }
  if (pos === -1) return null;

  const start = Math.max(0, pos - contextLen);
  const end = Math.min(text.length, pos + Math.max(q.length, 10) + contextLen);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

export type SessionSort = 'recent' | 'oldest' | 'alpha';

export const SESSION_SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'alpha', label: 'A–Z' },
];

export function sortSessions(sessions: Session[], sort: SessionSort): Session[] {
  const copy = [...sessions];
  switch (sort) {
    case 'oldest':
      return copy.sort(
        (a, b) => new Date(a.last_updated).getTime() - new Date(b.last_updated).getTime()
      );
    case 'alpha':
      return copy.sort((a, b) =>
        getSessionDisplayTitle(a, { includeAgentFallback: true }).localeCompare(
          getSessionDisplayTitle(b, { includeAgentFallback: true })
        )
      );
    case 'recent':
    default:
      return copy.sort(
        (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
      );
  }
}

export function HighlightMatch({ text, query }: { text: string; query: string }) {
  const { token } = theme.useToken();
  if (!query.trim() || !text) return <>{text}</>;

  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(re);

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? ( // odd indices are matches from split with capture group
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: positional marks in a static string split
            key={i}
            style={{
              background: token.colorWarningBg,
              color: 'inherit',
              padding: `0 ${token.paddingXXS}px`,
              borderRadius: token.borderRadiusSM,
            }}
          >
            {part}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional text in a static string split
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
