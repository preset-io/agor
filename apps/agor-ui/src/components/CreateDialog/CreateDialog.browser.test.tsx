import type { Repo } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CreateDialog } from './CreateDialog';

checkBrowserSanity();
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  agorStore.getState().reset();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it('renders real AntD persona borders and preserves create validity through tab switches', async () => {
  // Focused desktop interaction proof, not a responsive-layout or provisioning test.
  await page.viewport(1000, 900);
  const frameworkRepo = {
    repo_id: 'framework-repo',
    slug: 'preset-io/agor-teammate',
    name: 'agor-teammate',
    default_branch: 'main',
    repo_type: 'remote',
    remote_url: 'https://github.com/preset-io/agor-teammate.git',
    local_path: '/tmp/agor-teammate',
  } as Repo;
  agorStore.setState({
    ...EMPTY_MAPS,
    repoById: new Map([[frameworkRepo.repo_id, frameworkRepo]]),
  });
  const onCreateTeammate = vi.fn();
  render(
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
      onCreateTeammate={onCreateTeammate}
    />
  );

  // These document-wide role queries hit the cssstyle failure in jsdom. Do not
  // replace AntD, its CSS, or getComputedStyle: Chromium must compute real styles.
  expect(screen.getByRole('button', { name: 'Create AI teammate' })).toBeDisabled();
  const persona = screen.getByRole('button', { name: 'Legal Analyst' });
  expect(getComputedStyle(persona).borderTopWidth).toBe('1px');
  expect(getComputedStyle(persona).borderTopStyle).toBe('solid');
  await act(() => page.getByRole('button', { name: 'Legal Analyst' }).click());
  expect(persona).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Create AI teammate' })).toBeDisabled();
  await act(() => page.getByPlaceholder(/PR Reviewer/).fill('Legal Helper'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create AI teammate' })).toBeEnabled()
  );

  await act(() => page.getByRole('tab', { name: /Board/i }).click());
  expect(screen.getByRole('button', { name: 'Create Board' })).toBeDisabled();
  await act(() => page.getByRole('tab', { name: /Teammate/i }).click());
  expect(screen.getByRole('button', { name: 'Legal Analyst' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await act(() => page.getByRole('button', { name: 'Create AI teammate', exact: true }).click());
  await waitFor(() =>
    expect(onCreateTeammate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Legal Helper',
        templateId: 'legal-analyst',
        sourceBranch: 'template/legal-analyst',
        sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
        emoji: '⚖️',
        agent: 'claude-code',
        permissionMode: 'auto',
      }),
      expect.objectContaining({ onStatusChange: expect.any(Function) })
    )
  );
  expect(onCreateTeammate).toHaveBeenCalledTimes(1);
});
