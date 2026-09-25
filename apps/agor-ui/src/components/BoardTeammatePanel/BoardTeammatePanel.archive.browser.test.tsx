import type { AgorClient, Board, Branch, Repo, Session } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { bumpRevision } from '../../store/agorHydration';
import { buildSessionMaps } from '../../store/agorMaps';
import { sessionPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import { enqueueSessionPatch, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { checkBrowserSanity } from '../../test/browserSanity';
import { BoardTeammatePanel } from './BoardTeammatePanel';

checkBrowserSanity();

const branch = {
  branch_id: 'teammate-branch',
  repo_id: 'teammate-repo',
  name: 'Teammate',
  filesystem_status: 'ready',
} as Branch;
const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const repo = { repo_id: branch.repo_id, slug: 'test/teammate' } as Repo;

function session(id: string, genealogy: Session['genealogy'] = { children: [] }): Session {
  return {
    session_id: id,
    branch_id: branch.branch_id,
    title: id,
    agentic_tool: 'codex',
    status: 'idle',
    archived: false,
    created_at: '2026-09-01T00:00:00.000Z',
    last_updated: '2026-09-01T00:00:00.000Z',
    genealogy,
  } as Session;
}

const parent = session('Parent');
const child = session('Child', { parent_session_id: parent.session_id, children: [] });
const grandchild = session('Grandchild', { parent_session_id: child.session_id, children: [] });
const fork = session('Fork', { forked_from_session_id: parent.session_id, children: [] });
const unrelated = session('Unrelated');
const orphan = session('Orphan', {
  parent_session_id: 'unloaded-parent' as Session['session_id'],
  children: [],
});
const sessions = [parent, child, grandchild, fork, unrelated, orphan];

beforeEach(() => {
  localStorage.clear();
  agorStore.getState().reset();
  agorStore.getState().applyMaps((prev) => ({ ...prev, ...buildSessionMaps(sessions) }));
  setRealtimeAuthorityScope('browser-fixture:user:1');
});
afterEach(() => {
  cleanup();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

// Real Chromium and real drawer/store/confirmation controls, with a fixture RPC
// response and controlled realtime delivery. This is not authenticated E2E.
describe('teammate drawer archive reconciliation', () => {
  it.each([
    { target: parent, affected: [parent, child, grandchild, fork], remaining: [unrelated, orphan] },
    { target: child, affected: [child, grandchild], remaining: [parent, fork, unrelated, orphan] },
    { target: parent, affected: [child, grandchild, fork], remaining: [unrelated, orphan] },
    {
      target: parent,
      affected: [parent, child, grandchild, fork],
      remaining: [unrelated, orphan],
      race: 'inversion',
    },
    {
      target: parent,
      affected: [parent, child, grandchild, fork],
      remaining: sessions,
      race: 'restore',
    },
    ...(['failed-read', 'churn'] as const).map((race) => ({
      target: parent,
      affected: [parent, child, grandchild, fork],
      remaining: sessions,
      race,
    })),
  ])(
    'reconciles $target.title without refresh (race=$race)',
    async ({ target, affected, remaining, race }) => {
      const affectedSessions = affected.map((s) => ({
        ...s,
        archived: true,
        last_updated: '2026-09-01T00:00:02.000Z',
      }));
      const archivedRoot = affectedSessions.find((s) => s.session_id === target.session_id) ?? {
        ...target,
        archived: true,
        last_updated: '2026-09-01T00:00:01.000Z',
      };
      let resolve!: (value: { session: Session; affectedSessions: Session[] }) => void;
      const response = new Promise<{ session: Session; affectedSessions: Session[] }>((done) => {
        resolve = done;
      });
      const create = vi.fn(() => response);
      let finishRead!: () => void;
      const readGate = new Promise<void>((done) => {
        finishRead = done;
      });
      const get = vi.fn(async (id: string) => {
        await readGate;
        if (race === 'failed-read') throw new Error('Read unavailable');
        if (race === 'churn') {
          // Six read rounds plus retry backoff exceed RTL's default 1s wait,
          // even without CI scheduling and toast-animation overhead.
          await new Promise((done) => setTimeout(done, 100));
          bumpRevision('sessions');
          enqueueSessionPatch('browser-fixture:user:1', { ...unrelated, title: 'Unrelated' });
        }
        if (race === 'restore') return sessions.find((s) => s.session_id === id);
        return [archivedRoot, ...affectedSessions].find((s) => s.session_id === id);
      });
      const client = {
        service: vi.fn((name: string) => {
          if (name === `sessions/${target.session_id}/archive`) return { create };
          if (name === 'sessions') return { get };
          throw new Error(`Unexpected service: ${name}`);
        }),
      } as unknown as AgorClient;
      render(
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            authGeneration: 1,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <App>
            <div style={{ width: 420, height: 800 }}>
              <BoardTeammatePanel
                board={board}
                primaryTeammateBranch={branch}
                primaryTeammateRepo={repo}
                primaryTeammateInaccessible={false}
                onSessionClick={vi.fn()}
                client={client}
              />
            </div>
          </App>
        </ConnectionProvider>
      );
      for (const s of sessions) {
        expect(screen.getByRole('button', { name: `Open session ${s.title}` })).toBeVisible();
      }
      const row = screen
        .getByRole('button', { name: `Open session ${target.title}` })
        .closest('.ant-tree-treenode');
      expect(row).not.toBeNull();
      await act(async () => {
        await page.elementLocator(row!).hover();
      });
      await act(async () => {
        await page
          .elementLocator(
            within(row as HTMLElement).getByRole('button', { name: 'Archive session' })
          )
          .click();
      });
      await act(async () => {
        await page.getByRole('button', { name: 'Archive', exact: true }).click();
      });
      expect(create).toHaveBeenCalledWith({});
      // Pending requests leave the tree intact.
      expect(screen.getByRole('button', { name: `Open session ${target.title}` })).toBeVisible();
      await act(async () => {
        // Only a changed root emits a patch; an already-archived root emits nothing.
        if (race) {
          // Inversion: these active writes committed BEFORE the archive, despite
          // larger timestamps. Restore: these writes committed AFTER it. Only
          // the authoritative read can distinguish the two.
          for (const s of affected)
            sessionPatched({ ...s, last_updated: '2026-09-01T00:00:03.000Z' });
        } else if (affected.includes(target)) sessionPatched(archivedRoot);
        resolve({ session: archivedRoot, affectedSessions });
        await response;
      });
      await waitFor(() => expect(get).toHaveBeenCalled());
      // The mutation payload alone must not hide descendants while reads wait.
      expect(screen.getByRole('button', { name: 'Open session Grandchild' })).toBeVisible();
      await act(async () => {
        finishRead();
      });
      await waitFor(() => {
        for (const s of [target, ...affected].filter((s) => !remaining.includes(s))) {
          expect(
            screen.queryByRole('button', { name: `Open session ${s.title}` })
          ).not.toBeInTheDocument();
        }
      });
      for (const s of remaining) {
        expect(screen.getByRole('button', { name: `Open session ${s.title}` })).toBeVisible();
      }
      if (race === 'failed-read' || race === 'churn') {
        // Allow the bounded retries and the real toast entrance animation to
        // settle; the default 1s assertion deadline races both under CI load.
        await waitFor(
          () =>
            expect(
              screen.getByText(
                'Session and same-branch children archived; refresh required to update the session list.'
              )
            ).toBeVisible(),
          { timeout: 5_000 }
        );
        expect(screen.queryByText('Failed to archive session')).not.toBeInTheDocument();
        expect(
          screen.queryByText('Session and same-branch children archived')
        ).not.toBeInTheDocument();
        expect(create).toHaveBeenCalledTimes(1);
        if (race === 'churn') expect(get).toHaveBeenCalledTimes(6 * affected.length);
      } else {
        await waitFor(() =>
          expect(screen.getByText('Session and same-branch children archived')).toBeVisible()
        );
      }
    }
  );
});
