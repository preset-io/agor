import type { Board, User } from '@agor-live/client';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import {
  CatalogHarness,
  catalogUser,
  githubHandoffEntry,
  makeCatalogClient,
} from '../Marketplace/MCPCatalogModal.test-fixtures';
import { type OnboardingCompletionResult, OnboardingWizard } from './OnboardingWizard';

vi.mock('../EmojiPickerInput/EmojiPickerInput', () => ({
  EmojiPickerInput: () => <button type="button">Emoji</button>,
  AgorEmojiPicker: () => null,
  FormEmojiPickerInput: () => null,
}));
beforeEach(() => {
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([['board-1', { board_id: 'board-1', name: 'QA' } as Board]]),
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

// Real wizard and Catalog controller/drawer. API/provisioning fixtures are NOT vendor success.
function Harness({
  api,
  prepare,
  complete,
  update,
}: {
  api: ReturnType<typeof makeCatalogClient>;
  prepare: () => Promise<string>;
  complete: (result: OnboardingCompletionResult) => void;
  update: (...args: unknown[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const user: User = {
    ...catalogUser,
    onboarding_completed: false,
    preferences: { onboarding: { boardId: 'board-1', teammateDisplayName: 'QA' } },
  };
  return (
    <CatalogHarness client={api.client}>
      <OnboardingWizard
        open={open}
        initialStep="tools"
        user={user}
        client={api.client}
        onUpdateUser={async (...args) => {
          update(...args);
        }}
        onPrepareTools={prepare}
        onDismiss={() => setOpen(false)}
        onComplete={(result) => {
          complete(result);
          setOpen(false);
        }}
      />
    </CatalogHarness>
  );
}
async function click(name: RegExp | string) {
  await userEvent.click(await screen.findByRole('button', { name }));
}
async function openGitHub() {
  const card = screen.getByText('GitHub').closest<HTMLElement>('.ant-card')!;
  await userEvent.click(within(card).getByRole('button', { name: /^Sign in through Catalog/ }));
  const input = await screen.findByPlaceholderText('Paste your GitHub bearer access token');
  return { input, drawer: within(input.closest<HTMLElement>('[role="dialog"]')!) };
}

describe('onboarding-owned Catalog in Chromium', () => {
  it('supports keyboard selection, Back, PAT cancellation and focus restoration without provisioning', async () => {
    const api = makeCatalogClient([githubHandoffEntry]);
    const prepare = vi.fn(async () => 'branch-1');
    const complete = vi.fn();
    const update = vi.fn();
    render(<Harness api={api} prepare={prepare} complete={complete} update={update} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Choose your tools' })).toHaveFocus()
    );
    for (const name of [/Back$/, /Skip for now/, /^Continue/]) {
      const button = screen.getByRole('button', { name });
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    }
    const suggestion = screen.getByRole('checkbox', { name: 'Suggest GitHub to my teammate' });
    suggestion.focus();
    await userEvent.keyboard(' ');
    expect(suggestion).not.toBeChecked();
    await click(/^Continue/);
    await click(/Back$/);
    expect(
      screen.getByRole('checkbox', { name: 'Suggest GitHub to my teammate' })
    ).not.toBeChecked();
    const { input, drawer } = await openGitHub();
    expect(input).toHaveAttribute('type', 'password');
    for (const action of document.querySelectorAll<HTMLElement>(
      '.ant-modal .ant-btn-text, .ant-modal .ant-btn-link, .ant-drawer .ant-btn-text, .ant-drawer .ant-btn-link'
    )) {
      expect(getComputedStyle(action).paddingLeft).toBe('0px');
    }
    await waitFor(() => {
      const rect = input.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    });
    await userEvent.fill(input, 'test-only-not-a-provider-credential');
    await userEvent.click(drawer.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/bearer access token/)).not.toBeInTheDocument()
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    const reopened = await openGitHub();
    expect(reopened.input).toHaveValue('');
    await userEvent.click(reopened.input);
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/bearer access token/)).not.toBeInTheDocument()
    );
    expect(screen.getByRole('heading', { name: 'Choose your tools' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByText('GitHub').closest<HTMLElement>('.ant-card')!).getByRole('button', {
          name: /^Sign in through Catalog/,
        })
      ).toHaveFocus()
    );
    await click(/Skip for now/);
    await click(/Meet QA/);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ suggestedIntegrations: [] }));
    expect(JSON.stringify(update.mock.calls)).not.toContain('test-only-not-a-provider-credential');
  });

  it('prepares only on Connect, retries a refused PAT and returns in context before completion', async () => {
    const api = makeCatalogClient([githubHandoffEntry]);
    api.connect.mockRejectedValueOnce(new Error('Credential not accepted. Try again.'));
    const prepare = vi.fn(async () => 'branch-1');
    const complete = vi.fn();
    const update = vi.fn();
    render(<Harness api={api} prepare={prepare} complete={complete} update={update} />);
    const { input, drawer } = await openGitHub();
    expect(prepare).not.toHaveBeenCalled();
    await userEvent.fill(input, 'test-only-credential');
    await userEvent.click(
      drawer.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    await userEvent.click(drawer.getByRole('button', { name: /Verify key & connect/ }));
    await drawer.findByText('Credential not accepted. Try again.');
    await userEvent.fill(input, 'test-only-retry');
    await userEvent.click(drawer.getByRole('button', { name: /Verify key & connect/ }));
    await drawer.findByText('Connected and ready');
    expect(api.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        branch_id: 'branch-1',
        bearer_token: 'test-only-retry',
        acknowledged_disclosure: githubHandoffEntry.permission_disclosure,
      })
    );
    expect(complete).not.toHaveBeenCalled();
    await userEvent.click(drawer.getByRole('button', { name: 'Return to onboarding' }));
    await click(/^Continue/);
    await click(/Meet QA/);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ connectedMcpServerIds: ['server-1'] })
    );
    expect(JSON.stringify([...update.mock.calls, ...complete.mock.calls])).not.toContain(
      'test-only-retry'
    );
    expect(screen.getByTestId('route')).toHaveTextContent('/');
  });
});
