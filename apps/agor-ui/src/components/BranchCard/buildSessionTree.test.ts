import type { Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildSessionTree,
  collectSessionSubtreeIds,
  getSessionTreeParentId,
} from './buildSessionTree';

function makeSession(
  sessionId: string,
  genealogy: Session['genealogy'] = { children: [] }
): Session {
  return {
    session_id: sessionId,
    genealogy,
  } as Session;
}

describe('session tree genealogy', () => {
  it('uses one parent rule for tree construction and descendant collection', () => {
    const root = makeSession('root');
    const spawned = makeSession('spawned', {
      parent_session_id: root.session_id,
      children: [],
    });
    const forked = makeSession('forked', {
      forked_from_session_id: spawned.session_id,
      children: [],
    });
    const unrelated = makeSession('unrelated');
    const sessions = [root, spawned, forked, unrelated];

    expect(collectSessionSubtreeIds(sessions, [root.session_id])).toEqual(
      new Set(['root', 'spawned', 'forked'])
    );
    expect(buildSessionTree(sessions)).toMatchObject([
      {
        key: 'root',
        children: [{ key: 'spawned', children: [{ key: 'forked' }] }],
      },
      { key: 'unrelated' },
    ]);
  });

  it('falls back to a fork parent when a patched parent ID is empty', () => {
    const forked = makeSession('forked', {
      parent_session_id: '' as Session['session_id'],
      forked_from_session_id: 'root' as Session['session_id'],
      children: [],
    });

    expect(getSessionTreeParentId(forked)).toBe('root');
    expect(collectSessionSubtreeIds([forked], ['root'])).toEqual(new Set(['root', 'forked']));
  });

  it('records the rendered parent agent, including after an ancestor is filtered out', () => {
    const withTool = (session: Session, agentic_tool: string) =>
      ({ ...session, agentic_tool }) as Session;
    const root = withTool(makeSession('root'), 'codex');
    const child = withTool(
      makeSession('child', { parent_session_id: root.session_id, children: [] }),
      'claude-code'
    );
    const orphan = withTool(
      makeSession('orphan', {
        parent_session_id: 'archived' as Session['session_id'],
        children: [],
      }),
      'codex'
    );

    expect(buildSessionTree([root, child, orphan])).toMatchObject([
      {
        key: 'root',
        parentAgenticTool: undefined,
        children: [{ parentAgenticTool: 'codex', siblingShowsAgentIcon: true }],
      },
      { key: 'orphan', parentAgenticTool: undefined },
    ]);
  });
});
