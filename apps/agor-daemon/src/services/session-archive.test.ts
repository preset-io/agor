import type { Session, SessionID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  planBranchArchiveTransition,
  planBranchLocalArchiveRoots,
  planBranchUnarchiveTransition,
  planSessionTreeArchiveTransition,
} from './session-archive.js';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    session_id: id as SessionID,
    branch_id: 'branch-1',
    status: SessionStatus.IDLE,
    agentic_tool: 'claude-code',
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    created_by: 'user-1',
    sdk_home_scope: 'execution_home',
    contextFiles: [],
    tasks: [],
    genealogy: { children: [] },
    archived: false,
    ...overrides,
  } as Session;
}

describe('branch-local session archive planning', () => {
  it('preserves independent reasons and normalizes stale active reasons', () => {
    const root = session('root', { archived_reason: 'parent_archived' });
    const active = session('active');
    const manual = session('manual', { archived: true, archived_reason: 'manual' });

    expect(
      planSessionTreeArchiveTransition({
        root,
        descendants: [active, manual],
        archived: true,
        rootReason: 'manual',
      }).map((target) => [target.session.session_id, target.archivedReason])
    ).toEqual([
      ['root', 'manual'],
      ['active', 'parent_archived'],
    ]);

    expect(
      planSessionTreeArchiveTransition({
        root,
        descendants: [],
        archived: false,
        rootReason: 'manual',
      })
    ).toEqual([{ session: root, archived: false, archivedReason: null }]);
  });

  it('promotes a parent-caused root without overwriting an independent cause', () => {
    const parentCaused = session('parent-caused', {
      archived: true,
      archived_reason: 'parent_archived',
    });
    const independentlyArchived = session('independent', {
      archived: true,
      archived_reason: 'btw_completed',
    });

    expect(
      planSessionTreeArchiveTransition({
        root: parentCaused,
        descendants: [],
        archived: true,
        rootReason: 'manual',
      })
    ).toMatchObject([{ session: { session_id: 'parent-caused' }, archivedReason: 'manual' }]);
    expect(
      planSessionTreeArchiveTransition({
        root: independentlyArchived,
        descendants: [],
        archived: true,
        rootReason: 'manual',
      })
    ).toEqual([]);
  });

  it('archives and restores only the branch-owned cause', () => {
    const active = session('active');
    const manual = session('manual', { archived: true, archived_reason: 'manual' });
    const branchOwned = session('branch', {
      archived: true,
      archived_reason: 'branch_archived',
    });

    expect(planBranchArchiveTransition([active, manual, branchOwned])).toMatchObject([
      { session: { session_id: 'active' }, archivedReason: 'branch_archived' },
    ]);
    expect(planBranchUnarchiveTransition([active, manual, branchOwned])).toMatchObject([
      { session: { session_id: 'branch' }, archived: false, archivedReason: null },
    ]);
  });

  it('does not restore through an independently archived local ancestor', () => {
    const root = session('root', { archived: true, archived_reason: 'manual' });
    const independent = session('independent', {
      archived: true,
      archived_reason: 'manual',
      genealogy: { parent_session_id: root.session_id, children: [] },
    });
    const covered = session('covered', {
      archived: true,
      archived_reason: 'parent_archived',
      genealogy: { parent_session_id: independent.session_id, children: [] },
    });

    expect(
      planSessionTreeArchiveTransition({
        root,
        descendants: [independent, covered],
        archived: false,
        rootReason: 'manual',
      }).map((target) => target.session.session_id)
    ).toEqual(['root']);
  });

  it('deduplicates overlapping bulk trees while keeping matched descendants as roots', () => {
    const root = session('root');
    const selectedChild = session('selected-child');
    const descendant = session('descendant');
    const plan = planBranchLocalArchiveRoots({
      roots: [root, selectedChild],
      descendantsByRoot: new Map([
        [root.session_id, [selectedChild, descendant]],
        [selectedChild.session_id, [descendant]],
      ]),
      includeChildren: true,
    });

    expect(plan.units).toHaveLength(1);
    expect(plan.additionalDescendants.map((item) => item.session_id)).toEqual(['descendant']);
    expect(
      plan.units[0]?.targets.map((target) => [target.session.session_id, target.archivedReason])
    ).toEqual([
      ['root', 'manual'],
      ['selected-child', 'manual'],
      ['descendant', 'parent_archived'],
    ]);
  });
});
