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
 *  2. A sibling tab's deferred validity push (e.g. BranchTab's
 *     `setTimeout(0)` in its init effect) could land in the shared bucket
 *     after the active tab's valid push, clobbering it.
 *
 * The fix is to index validity by tab key — each tab writes only to its
 * own slot, and the footer reads `validByTab[activeTab]`.
 */

import type { Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
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
  slug: 'preset-io/agor-teammate',
  name: 'agor-teammate',
  remote_url: 'https://github.com/preset-io/agor-teammate.git',
});

const userRepo = makeRepo({
  repo_id: 'user-repo',
  slug: 'org/user-repo',
  name: 'user-repo',
});

function renderDialog(props: Partial<React.ComponentProps<typeof CreateDialog>> = {}) {
  // CreateDialog reads entity maps from the store, so seed the repos there
  // rather than passing them as props.
  const repoById = new Map<string, Repo>([
    [frameworkRepo.repo_id, frameworkRepo],
    [userRepo.repo_id, userRepo],
  ]);
  agorStore.setState({ ...EMPTY_MAPS, repoById });

  return render(
    <CreateDialog
      open
      onClose={vi.fn()}
      availableAgents={[
        { id: 'claude-code', name: 'Claude Code', icon: '🤖', description: 'Claude' },
      ]}
      onCreateBranch={vi.fn()}
      onCreateBoard={vi.fn()}
      onCreateRepo={vi.fn()}
      onCreateLocalRepo={vi.fn()}
      onCreateTeammate={vi.fn()}
      {...props}
    />
  );
}

// Each test renders an antd Modal + Tabs and exercises tab-switching. That's
// heavy in jsdom — Modal motion CSS never fires transitionend, the portal
// mounts/unmounts every test, and finding labels inside Tabs panes is slow.
// On the GitHub runner a single mount + first input change runs ~10s, and
// every tab click adds ~7-8s of React-commit work to that. Give individual
// findBy / waitFor helpers an explicit 10s budget so they aren't racing the
// whole-test timeout.
const ASYNC = { timeout: 10_000 };

describe('CreateDialog — per-tab validity scoping', { timeout: 60_000 }, () => {
  it('defaults to Teammate as the primary create path', async () => {
    renderDialog();

    expect(await screen.findByRole('tab', { name: /Teammate/i }, ASYNC)).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('button', { name: /Create AI teammate/i })).toBeDisabled();
  });

  it('enables Create AI teammate once Name is typed', async () => {
    renderDialog({ defaultTab: 'teammate' });

    const displayName = (await screen.findByPlaceholderText(
      /PR Reviewer/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: 'My Teammate' } });

    const button = screen.getByRole('button', { name: /Create AI teammate/i });
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    }, ASYNC);
  });

  it('preserves Teammate validity when user switches tabs and switches back', async () => {
    renderDialog({ defaultTab: 'teammate' });

    const displayName = (await screen.findByPlaceholderText(
      /PR Reviewer/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: 'My Teammate' } });

    // Switch away and back without asserting on the interim state — that
    // assertion isn't load-bearing for this regression and each waitFor pass
    // adds 5-8s of overhead in CI.
    fireEvent.click(screen.getByRole('tab', { name: /Board/i }));
    fireEvent.click(screen.getByRole('tab', { name: /Teammate/i }));

    // Name is still filled — submit must be enabled without the user
    // having to re-touch the field. Pre-fix: handleTabChange reset the shared
    // isValid to false and TeammateTab's useEffect didn't re-fire (its
    // isFormValid hadn't changed), so the button stayed stuck disabled.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create AI teammate/i })).not.toBeDisabled();
    }, ASYNC);
  });

  it('submits teammate agentic defaults with the teammate fields', async () => {
    const onCreateTeammate = vi.fn();
    renderDialog({ defaultTab: 'teammate', onCreateTeammate });

    const displayName = (await screen.findByPlaceholderText(
      /PR Reviewer/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: 'Bootstrap Bot' } });

    const button = screen.getByRole('button', { name: /Create AI teammate/i });
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    }, ASYNC);

    fireEvent.click(button);

    await waitFor(() => {
      expect(onCreateTeammate).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: 'Bootstrap Bot',
          emoji: '🤖',
          agent: 'claude-code',
          permissionMode: 'auto',
        }),
        expect.objectContaining({ onStatusChange: expect.any(Function) })
      );
    }, ASYNC);
  });

  it('reports each tab its own validity (no spillover when switching to an empty tab)', async () => {
    renderDialog({ defaultTab: 'teammate' });

    const displayName = (await screen.findByPlaceholderText(
      /PR Reviewer/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: 'My Teammate' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create AI teammate/i })).not.toBeDisabled();
    }, ASYNC);

    // Switch to Board (its form is empty). The footer's submit must reflect
    // Board's validity, not leak Teammate's "true" into Create Board.
    fireEvent.click(screen.getByRole('tab', { name: /Board/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Board/i })).toBeDisabled();
    }, ASYNC);
  });
});
