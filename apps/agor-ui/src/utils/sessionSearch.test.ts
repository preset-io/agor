import type { Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getHighlightTerms } from './highlightTerms';
import {
  getMatchSnippet,
  isSessionSearchActive,
  scoreSession,
  searchSessions,
  sessionToolMatches,
  sortSessions,
} from './sessionSearch';

const NOW = new Date('2026-06-03T12:00:00Z').getTime();

function session(overrides: Partial<Session>): Session {
  return {
    session_id: crypto.randomUUID() as Session['session_id'],
    agentic_tool: 'claude-code',
    status: 'completed',
    created_at: '2026-06-01T00:00:00Z',
    last_updated: '2026-06-01T00:00:00Z',
    created_by: 'user-1',
    unix_username: null,
    branch_id: 'branch-1' as Session['branch_id'],
    url: null,
    git_state: { ref: 'main', base_sha: 'base', current_sha: 'head' },
    contextFiles: [],
    genealogy: { children: [] },
    tasks: [],
    ...overrides,
  };
}

describe('sessionSearch', () => {
  it('does not return status-only matches for unrelated running sessions', () => {
    const running = session({ title: 'Deploy logs', status: 'running' });

    expect(scoreSession(running, 'billing', NOW)).toBe(0);
    expect(searchSessions([running], 'billing', { now: NOW })).toEqual([]);
  });

  it('ranks stronger title matches ahead of description-only matches', () => {
    const titleMatch = session({ title: 'Billing cache cleanup' });
    const descriptionMatch = session({
      title: 'Unrelated',
      description: 'Investigate billing cache',
    });

    const results = searchSessions([descriptionMatch, titleMatch], 'billing cache', { now: NOW });

    expect(results.map(({ session }) => session.session_id)).toEqual([
      titleMatch.session_id,
      descriptionMatch.session_id,
    ]);
  });

  it('uses canonical AND-of-tokens eligibility before scoring', () => {
    const fullMatch = session({ title: 'Billing cache cleanup' });
    const partialMatch = session({ title: 'Billing-only cleanup' });

    const results = searchSessions([partialMatch, fullMatch], 'billing cache', { now: NOW });

    expect(results.map(({ session }) => session.session_id)).toEqual([fullMatch.session_id]);
  });

  it('supports canonical tool matches that callers can render visibly', () => {
    const codexSession = session({ agentic_tool: 'codex', title: 'Unrelated' });

    expect(sessionToolMatches(codexSession, 'codex')).toBe(true);
    expect(searchSessions([codexSession], 'codex', { now: NOW })[0].session.session_id).toBe(
      codexSession.session_id
    );
  });

  it('uses recency as a relevance boost within actual matches', () => {
    const oldMatch = session({ title: 'Billing report', last_updated: '2026-05-01T00:00:00Z' });
    const newMatch = session({ title: 'Billing report', last_updated: '2026-06-03T11:00:00Z' });

    const results = searchSessions([oldMatch, newMatch], 'billing', { now: NOW });

    expect(results[0].session.session_id).toBe(newMatch.session_id);
  });

  it('boosts stopping sessions the same way as running sessions', () => {
    const idle = session({ title: 'Billing report', status: 'idle' });
    const stopping = session({ title: 'Billing report', status: 'stopping' });

    expect(scoreSession(stopping, 'billing', NOW)).toBeGreaterThan(
      scoreSession(idle, 'billing', NOW)
    );
  });

  it('sorts sessions by recent, oldest, and alpha labels', () => {
    const a = session({ title: 'Alpha', last_updated: '2026-06-01T00:00:00Z' });
    const b = session({ title: 'Beta', last_updated: '2026-06-02T00:00:00Z' });

    expect(sortSessions([a, b], 'recent').map((s) => s.title)).toEqual(['Beta', 'Alpha']);
    expect(sortSessions([a, b], 'oldest').map((s) => s.title)).toEqual(['Alpha', 'Beta']);
    expect(sortSessions([b, a], 'alpha').map((s) => s.title)).toEqual(['Alpha', 'Beta']);
  });

  it('creates snippets around phrase or term matches', () => {
    const snippet = getMatchSnippet('before the important billing migration after', 'billing', 10);

    expect(snippet).toContain('billing');
    expect(snippet?.startsWith('…')).toBe(true);
    expect(snippet?.endsWith('…')).toBe(true);
    expect(getMatchSnippet('alpha beta gamma', 'missing')).toBeNull();
  });

  it('derives highlight terms from phrase and words while ignoring one-character noise', () => {
    expect(isSessionSearchActive('A')).toBe(false);
    expect(isSessionSearchActive('AI')).toBe(true);
    expect(getHighlightTerms('AI billing cache')).toEqual([
      'AI billing cache'.toLowerCase(),
      'billing',
      'cache',
      'ai',
    ]);
    expect(getHighlightTerms('a billing cache')).toEqual(['billing', 'cache']);
    expect(getHighlightTerms('billing cache')).toEqual(['billing cache', 'billing', 'cache']);
  });
});
