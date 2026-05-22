/**
 * Regression tests for per-tab validity scoping in CreateDialog.
 *
 * The dialog used to keep a single `isValid` state that all four tab
 * components wrote into via the same `onValidityChange` callback. Two
 * symptoms fell out of that:
 *
 *  1. Switching to a tab you previously made valid left the submit button
 *     stuck disabled: `handleTabChange` reset `isValid` to false, and the
 *     active tab's effect did not re-fire (its own `isFormValid` had not
 *     changed), so nothing re-pushed the true value.
 *
 *  2. A sibling tab's deferred validity push (e.g. WorktreeTab's
 *     `setTimeout(0)` in its init effect) could land in the shared bucket
 *     after the active tab's valid push, clobbering it.
 *
 * The fix is to index validity by tab key — each tab writes only to its
 * own slot, and the footer reads `validByTab[activeTab]`.
 */

import type { Board, Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateDialog } from './CreateDialog';

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'org/repo-1',
    name: 'repo-1',
    default_branch: 'main',
    repo_type: 'remote',
    remote_url: 'https://github.com/org/repo-1.git',
    local_path: '/tmp/repo-1',
    ...overrides,
  } as unknown as Repo;
}

const frameworkRepo = makeRepo({
  repo_id: 'framework-repo',
  slug: 'preset-io/agor-assistant',
  name: 'agor-assistant',
  remote_url: 'https://github.com/preset-io/agor-assistant.git',
});

const userRepo = makeRepo({
  repo_id: 'user-repo',
  slug: 'org/user-repo',
  name: 'user-repo',
});

function renderDialog(props: Partial<React.ComponentProps<typeof CreateDialog>> = {}) {
  const repoById = new Map<string, Repo>([
    [frameworkRepo.repo_id, frameworkRepo],
    [userRepo.repo_id, userRepo],
  ]);
  const boardById = new Map<string, Board>();

  return render(
    <CreateDialog
      open
      onClose={vi.fn()}
      repoById={repoById}
      boardById={boardById}
      onCreateWorktree={vi.fn()}
      onCreateBoard={vi.fn()}
      onCreateRepo={vi.fn()}
      onCreateLocalRepo={vi.fn()}
      onCreateAssistant={vi.fn()}
      {...props}
    />
  );
}

// Each test renders an antd Modal + Tabs and exercises tab-switching. That's
// heavy in jsdom — Modal motion CSS never fires transitionend, the portal
// mounts/unmounts every test, and finding labels inside Tabs panes is slow.
// On the GitHub runner a single test can take 9-10s just to mount + query, so
// the per-test budget needs more headroom than the vitest default. Same goes
// for the individual findBy / waitFor helpers — give them ~5s each so the
// whole-test timeout isn't doubling as the only safety net.
const ASYNC = { timeout: 5_000 };

describe('CreateDialog — per-tab validity scoping', { timeout: 30_000 }, () => {
  it('enables Create Assistant once Display Name is typed', async () => {
    renderDialog({ defaultTab: 'assistant' });

    const displayName = (await screen.findByLabelText(
      /Display Name/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: 'My Assistant' } });

    const button = screen.getByRole('button', { name: /Create Assistant/i });
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    }, ASYNC);
  });

  it('preserves Assistant validity when user switches tabs and switches back', async () => {
    renderDialog({ defaultTab: 'assistant' });

    const displayName = (await screen.findByLabelText(
      /Display Name/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: 'My Assistant' } });

    const button = screen.getByRole('button', { name: /Create Assistant/i });
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    }, ASYNC);

    // Switch away to a tab whose form is empty (and therefore invalid).
    fireEvent.click(screen.getByRole('tab', { name: /Board/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Board/i })).toBeDisabled();
    }, ASYNC);

    // Switch back. Display Name is still filled — submit must be enabled
    // without the user having to re-touch the field.
    fireEvent.click(screen.getByRole('tab', { name: /Assistant/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Assistant/i })).not.toBeDisabled();
    }, ASYNC);
  });

  it('reports each tab its own validity (no spillover when switching to an empty tab)', async () => {
    renderDialog({ defaultTab: 'assistant' });

    const displayName = (await screen.findByLabelText(
      /Display Name/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: 'My Assistant' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Assistant/i })).not.toBeDisabled();
    }, ASYNC);

    // Switch to Board (its form is empty). The footer's submit must reflect
    // Board's validity, not leak Assistant's "true" into Create Board.
    fireEvent.click(screen.getByRole('tab', { name: /Board/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Board/i })).toBeDisabled();
    }, ASYNC);
  });
});
