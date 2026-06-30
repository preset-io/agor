import type { BranchID, Session } from '@agor-live/client';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ZoneTriggerModal } from './ZoneTriggerModal';

// Isolate the modal's own smart-default selection logic from its heavy config
// children — the regression lives entirely in ZoneTriggerModal's render-time
// useMemo, which runs regardless of what these children render.
vi.mock('../../AgentSelectionGrid', () => ({
  AgentSelectionGrid: () => null,
}));
vi.mock('../../AgenticToolConfigForm', () => ({
  AgenticToolConfigForm: () => null,
}));

const BRANCH_ID = 'branch-1' as BranchID;

const makeSession = (id: string, status: string, lastUpdated: string, title: string): Session =>
  ({
    session_id: id,
    branch_id: BRANCH_ID,
    status,
    title,
    archived: false,
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: lastUpdated,
  }) as unknown as Session;

describe('ZoneTriggerModal smart-default session selection', () => {
  it('resolves the most-recent session without mutating the frozen store bucket', () => {
    const older = makeSession('s-old', 'completed', '2026-06-01T00:00:00.000Z', 'Older session');
    const newer = makeSession('s-new', 'completed', '2026-06-20T00:00:00.000Z', 'Newer session');

    // The store uses Immer, which deeply freezes every `sessionsByBranch`
    // bucket. Sorting such an array in place throws, so the modal must sort a
    // copy. Freeze here to reproduce the store's contract.
    const frozenBucket = Object.freeze([older, newer]);
    const sessionsByBranch = new Map<string, Session[]>([[BRANCH_ID, frozenBucket]]);

    expect(() =>
      render(
        <ZoneTriggerModal
          open
          onCancel={() => {}}
          client={null}
          branchId={BRANCH_ID}
          branch={undefined}
          sessionsByBranch={sessionsByBranch}
          zoneName="Zone"
          trigger={{ template: 'do {{thing}}' } as never}
          availableAgents={[]}
          mcpServerById={new Map()}
          onExecute={async () => {}}
        />
      )
    ).not.toThrow();

    // With no running sessions, the smart default is the most-recently-updated
    // session — surfaced as the closed Select's selected value.
    expect(document.body.textContent).toContain('Newer session');
    expect(document.body.textContent).not.toContain('Older session');
  });
});
