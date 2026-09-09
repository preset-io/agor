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
  complete,
  update,
}: {
  api: ReturnType<typeof makeCatalogClient>;
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
  const dialog = input.closest<HTMLElement>('[role="dialog"]')!;
  await waitFor(() => {
    expect(dialog.getBoundingClientRect().right).toBeCloseTo(window.innerWidth, 1);
    expect(
      dialog
        .closest('.ant-drawer-content-wrapper')!
        .getAnimations()
        .some((animation) => animation.playState === 'running')
    ).toBe(false);
  });
  return { input, drawer: within(dialog) };
}

/** Measure the real portalled drawer, not the modal behind it. */
function drawerSpacing(dialog: HTMLElement) {
  const root = dialog.closest('.ant-drawer')!;
  const header = root.querySelector<HTMLElement>('.ant-drawer-header')!;
  const body = root.querySelector<HTMLElement>('.ant-drawer-body')!;
  const content = body.firstElementChild as HTMLElement;
  const disclosure = within(dialog).getByRole('button', { name: 'What this can access' });
  const sections = disclosure.parentElement!;
  const sectionBody = sections.querySelector<HTMLElement>('.ant-collapse-body')!;
  const connect = within(dialog).getByRole('button', {
    name: 'Connect',
  });
  const spacing = (element: Element) => {
    const style = getComputedStyle(element);
    return [
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'marginTop',
      'marginBottom',
      'rowGap',
    ].map((property) => style[property as keyof CSSStyleDeclaration]);
  };
  expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
  expect(root.querySelector('.ant-drawer-footer')).toBeNull(); // Both use in-body actions.
  expect(content).toHaveClass('ant-flex');
  expect(content.parentElement).toBe(body); // No onboarding padding wrapper.
  return {
    width: dialog.getBoundingClientRect().width,
    headerHeight: header.getBoundingClientRect().height,
    header: spacing(header),
    body: spacing(body),
    content: spacing(content),
    disclosure: spacing(disclosure),
    sectionBody: spacing(sectionBody),
    action: spacing(connect),
    actionWidth: connect.getBoundingClientRect().width,
  };
}

describe('onboarding-owned Catalog in Chromium', () => {
  it.each(['credentials', 'oauth'] as const)(
    'shares Catalog header/body/inline-action spacing and responsive width for %s auth',
    async (authType) => {
      const entry = {
        ...githubHandoffEntry,
        auth_type: authType,
        credentials: authType === 'credentials' ? githubHandoffEntry.credentials : undefined,
      };
      const api = makeCatalogClient([entry]);
      vi.mocked(api.client.service('mcp-catalog/readiness').get).mockResolvedValue({
        catalog_key: entry.name,
        state: authType === 'credentials' ? 'bearer_required' : 'oauth_required',
      });
      const standard = render(<CatalogHarness client={api.client} />);
      await userEvent.click(screen.getByRole('button', { name: 'Open MCP Catalog' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Open GitHub' }));
      const catalogDialog = await screen.findByRole('dialog', { name: /GitHub/ });
      await within(catalogDialog).findByRole('button', {
        name: 'Connect',
      });
      await waitFor(() =>
        expect(catalogDialog.getBoundingClientRect().right).toBeCloseTo(window.innerWidth, 0)
      );
      const expected = drawerSpacing(catalogDialog);
      expect(expected.width).toBe(Math.min(520, window.innerWidth));
      standard.unmount();

      render(<Harness api={api} complete={vi.fn()} update={vi.fn()} />);
      const row = screen.getByText('GitHub').closest<HTMLElement>('.ant-card')!;
      await userEvent.click(within(row).getByRole('button', { name: /^Sign in through Catalog/ }));
      const onboardingDialog = await screen.findByRole('dialog', { name: /GitHub/ });
      await within(onboardingDialog).findByRole('button', {
        name: 'Connect',
      });
      await waitFor(() =>
        expect(onboardingDialog.getBoundingClientRect().right).toBeCloseTo(window.innerWidth, 0)
      );
      const actual = drawerSpacing(onboardingDialog);
      // Browser transforms can introduce tiny fractional CSS-pixel rounding.
      // Spacing tokens stay exact; geometry must agree to 0.01 CSS pixels.
      const { width, headerHeight, actionWidth, ...spacing } = actual;
      const {
        width: expectedWidth,
        headerHeight: expectedHeaderHeight,
        actionWidth: expectedActionWidth,
        ...expectedSpacing
      } = expected;
      expect(spacing).toEqual(expectedSpacing);
      expect(width).toBeCloseTo(expectedWidth, 2);
      expect(headerHeight).toBeCloseTo(expectedHeaderHeight, 2);
      expect(actionWidth).toBeCloseTo(expectedActionWidth, 2);
      expect(document.querySelectorAll('.ant-drawer-open')).toHaveLength(1);
      expect(api.connect).not.toHaveBeenCalled();
      await userEvent.click(within(onboardingDialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(onboardingDialog).not.toBeInTheDocument());
      await waitFor(() =>
        expect(within(row).getByRole('button', { name: /^Sign in through Catalog/ })).toHaveFocus()
      );
    }
  );

  it('supports keyboard selection, Back, PAT cancellation and focus restoration without provisioning', async () => {
    const api = makeCatalogClient([githubHandoffEntry]);
    const complete = vi.fn();
    const update = vi.fn();
    render(<Harness api={api} complete={complete} update={update} />);
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

  it('installs without workspace or session creation, retries a refused PAT and returns in context before completion', async () => {
    const api = makeCatalogClient([githubHandoffEntry]);
    api.connect.mockRejectedValueOnce(
      new Error('Could not connect this server. Check your credentials and try again.')
    );
    const complete = vi.fn();
    const update = vi.fn();
    render(<Harness api={api} complete={complete} update={update} />);
    const { input, drawer } = await openGitHub();
    await userEvent.fill(input, 'test-only-credential');
    await userEvent.click(
      drawer.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    await userEvent.click(drawer.getByRole('button', { name: 'Connect' }));
    await drawer.findByText('Could not connect this server. Check your credentials and try again.');
    await userEvent.fill(input, 'test-only-retry');
    await userEvent.click(drawer.getByRole('button', { name: 'Connect' }));
    await drawer.findByText('Connected and ready');
    expect(api.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bearer_token: 'test-only-retry',
        acknowledged_disclosure: githubHandoffEntry.permission_disclosure,
      })
    );
    expect(complete).not.toHaveBeenCalled();
    expect(api.client.service('mcp-catalog/start-session').create).not.toHaveBeenCalled();
    expect(api.client.service('sessions').create).not.toHaveBeenCalled();
    expect(api.client.service('boards').create).not.toHaveBeenCalled();
    expect(drawer.queryByRole('button', { name: /Start.*session/ })).not.toBeInTheDocument();
    expect(drawer.queryByRole('combobox')).not.toBeInTheDocument();
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
