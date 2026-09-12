/**
 * Tests for the split single-purpose create modals (formerly the 4-tab
 * CreateDialog): standalone validity/submit per modal, and the template-first
 * prefill on the teammate modal.
 */

import type { Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { CreateBoardModal } from './CreateBoardModal';
import { CreateTeammateModal } from './CreateTeammateModal';

// The real TeammateTemplatePicker renders antd `Card` grids whose `border`
// CSS-var shorthand crashes cssstyle under Testing Library's getComputedStyle
// visibility checks (a jsdom limitation, not a product bug). The gallery's own
// rendering is covered by TeammateGallery.test.tsx; here we stub the picker to a
// bare button so we still exercise the modal + the real prefill wiring in
// TeammateTab.handleTemplateChange.
vi.mock('./TeammateTemplatePicker', () => ({
  TeammateTemplatePicker: ({ onChange }: { onChange: (id: string) => void }) => (
    <button type="button" onClick={() => onChange('chief-of-staff')}>
      Chief of Staff
    </button>
  ),
}));

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

const AGENTS = [{ id: 'claude-code', name: 'Claude Code', icon: '🤖', description: 'Claude' }];

// jsdom Modal motion + antd form commits are heavy; give async helpers headroom.
const ASYNC = { timeout: 10_000 };

function seedRepos() {
  agorStore.setState({
    ...EMPTY_MAPS,
    repoById: new Map<string, Repo>([[frameworkRepo.repo_id, frameworkRepo]]),
  });
}

describe('CreateTeammateModal', { timeout: 60_000 }, () => {
  it('disables submit until a name is present', async () => {
    seedRepos();
    render(
      <CreateTeammateModal
        open
        onClose={vi.fn()}
        availableAgents={AGENTS}
        onCreateTeammate={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /Create AI teammate/i })).toBeDisabled();
    fireEvent.change(await screen.findByPlaceholderText(/PR Reviewer/i, undefined, ASYNC), {
      target: { value: 'My Teammate' },
    });
    await waitFor(
      () => expect(screen.getByRole('button', { name: /Create AI teammate/i })).not.toBeDisabled(),
      ASYNC
    );
  });

  it('prefills the name from a selected template', async () => {
    seedRepos();
    render(
      <CreateTeammateModal
        open
        onClose={vi.fn()}
        availableAgents={AGENTS}
        onCreateTeammate={vi.fn()}
      />
    );

    const nameInput = (await screen.findByPlaceholderText(
      /PR Reviewer/i,
      undefined,
      ASYNC
    )) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Chief of Staff' }));

    // Selecting a template prefills the editable fields live.
    await waitFor(() => expect(nameInput.value).toBe('Chief of Staff'), ASYNC);
  });

  it('submits teammate agentic defaults', async () => {
    const onCreateTeammate = vi.fn();
    seedRepos();
    render(
      <CreateTeammateModal
        open
        onClose={vi.fn()}
        availableAgents={AGENTS}
        onCreateTeammate={onCreateTeammate}
      />
    );

    fireEvent.change(await screen.findByPlaceholderText(/PR Reviewer/i, undefined, ASYNC), {
      target: { value: 'Bootstrap Bot' },
    });
    const button = screen.getByRole('button', { name: /Create AI teammate/i });
    await waitFor(() => expect(button).not.toBeDisabled(), ASYNC);
    fireEvent.click(button);

    await waitFor(
      () =>
        expect(onCreateTeammate).toHaveBeenCalledWith(
          expect.objectContaining({
            displayName: 'Bootstrap Bot',
            emoji: '🤖',
            agent: 'claude-code',
            permissionMode: 'auto',
          }),
          expect.objectContaining({ onStatusChange: expect.any(Function) })
        ),
      ASYNC
    );
  });
});

describe('CreateBoardModal', { timeout: 60_000 }, () => {
  it('creates a board with no persisted background (uses the themed default)', async () => {
    const onCreateBoard = vi.fn();
    agorStore.setState({ ...EMPTY_MAPS });
    render(<CreateBoardModal open onClose={vi.fn()} onCreateBoard={onCreateBoard} />);

    fireEvent.change(await screen.findByPlaceholderText('My Board', undefined, ASYNC), {
      target: { value: 'Launch Board' },
    });
    const button = screen.getByRole('button', { name: /Create Board/i });
    await waitFor(() => expect(button).not.toBeDisabled(), ASYNC);
    fireEvent.click(button);

    await waitFor(
      () =>
        expect(onCreateBoard).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Launch Board', background_color: null })
        ),
      ASYNC
    );
  });
});
