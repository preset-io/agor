import type { User } from '@agor-live/client';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { MCPCatalogSelection } from '../../contexts/MCPCatalogModalContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import {
  CatalogHarness,
  catalogUser,
  githubHandoffEntry,
  makeCatalogClient,
} from '../Marketplace/MCPCatalogModal.test-fixtures';
import { OnboardingWizard } from './OnboardingWizard';

vi.mock('../EmojiPickerInput/EmojiPickerInput', () => ({
  EmojiPickerInput: () => <button type="button">Emoji</button>,
  AgorEmojiPicker: () => null,
  FormEmojiPickerInput: () => null,
}));
beforeEach(() => {
  agorStore.setState({ ...EMPTY_MAPS });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

// Real wizard, modal and drawer; API/provisioning are controlled fixtures, not vendor success.
function OnboardingCatalogHarness({ api }: { api: ReturnType<typeof makeCatalogClient> }) {
  const [open, setOpen] = useState(true);
  const [handoff, setHandoff] = useState<MCPCatalogSelection>();
  const user: User = { ...catalogUser, onboarding_completed: false, preferences: {} };
  return (
    <CatalogHarness
      client={api.client}
      handoff={handoff}
      onHandoffConsumed={() => setHandoff(undefined)}
    >
      <OnboardingWizard
        open={open}
        initialStep="tools"
        user={user}
        client={api.client}
        onUpdateUser={async () => undefined}
        onDismiss={() => setOpen(false)}
        onComplete={(result) => {
          setOpen(false);
          if (result.catalogEntryName !== undefined) {
            setHandoff({ branchId: 'branch-1', entryName: result.catalogEntryName ?? undefined });
          }
        }}
      />
    </CatalogHarness>
  );
}

async function click(name: RegExp | string) {
  await userEvent.click(await screen.findByRole('button', { name }));
}

describe('onboarding tools to Catalog in Chromium', () => {
  it('supports keyboard selection, Back, PAT handoff and cancellation without connecting', async () => {
    const api = makeCatalogClient([githubHandoffEntry]);
    render(<OnboardingCatalogHarness api={api} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Choose your tools' })).toHaveFocus()
    );
    for (const name of ['Linear', 'Notion', 'Firecrawl', 'Slack']) {
      const button = screen.getByText(name).closest('button')!;
      button.focus();
      await userEvent.keyboard(' ');
      await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
    }
    const github = screen.getByText('GitHub').closest('button')!;
    expect(github).toHaveAttribute('aria-pressed', 'true');
    const rect = github.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(screen.queryByPlaceholderText(/bearer access token/)).not.toBeInTheDocument();
    await click(/^Continue/);
    await click(/Back$/);
    expect(screen.getByText('GitHub').closest('button')).toHaveAttribute('aria-pressed', 'true');
    await click(/^Continue/);
    await click(/Open my board/);
    const input = await screen.findByPlaceholderText('Paste your GitHub bearer access token');
    const drawer = input.closest<HTMLElement>('[role="dialog"]')!;
    await within(drawer).findByText('Catalog QA');
    expect(api.connect).not.toHaveBeenCalled();
    await userEvent.fill(input, 'test-only-not-a-provider-credential');
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/bearer access token/)).not.toBeInTheDocument()
    );
    // AntD uses shared test-only portal IDs: Escape may also close the owner.
    // Either way, cancellation must discard the credential without connecting.
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('Skip overrides a requested browse handoff and creates no connection', async () => {
    const api = makeCatalogClient([githubHandoffEntry]);
    render(<OnboardingCatalogHarness api={api} />);
    await click(/Browse the full catalog after setup/);
    await click(/Skip for now/);
    await click(/Open my board/);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.connect).not.toHaveBeenCalled();
  });
});
