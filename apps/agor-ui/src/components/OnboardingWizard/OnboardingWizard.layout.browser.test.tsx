/**
 * Real-browser (Playwright + Chromium) layout regressions for the widened
 * onboarding modal. jsdom can't resolve `grid-template-columns` to real track
 * pixels or measure wrapped text height, so these must run in an actual browser:
 *
 *  1. The teammate step's compact template cards lay out as THREE columns at
 *     the widened (730px) modal and two on phones.
 *  2. The three Claude sign-in methods use equal tracks and stack cleanly at
 *     the 320px phone viewport instead of leaving a ragged wrapped row.
 *
 * Run: pnpm vitest run --config vitest.browser.config.ts
 */
import { type BoardID, boardPath, type User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { theme as antdTheme, ConfigProvider } from 'antd';
import { type ComponentProps, useEffect, useState } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOnboardingLifecycle } from '../../hooks/useOnboardingLifecycle';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { hasObservedOnboardingCompletion } from '../../utils/currentUserAuthority';
import type { WizardStep } from './OnboardingWizard';
import { OnboardingWizard } from './OnboardingWizard';

// The real emoji picker pulls a heavy dataset; stub it to a plain button so the
// wizard mounts fast. Its footprint is irrelevant to these layout checks.
vi.mock('../EmojiPickerInput/EmojiPickerInput', () => ({
  EmojiPickerInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange(value)} aria-label="emoji picker">
      {value}
    </button>
  ),
}));

function makeUser(): User {
  return {
    user_id: 'user-1',
    email: 'new-user@example.com',
    name: 'New User',
    role: 'member',
    onboarding_completed: false,
    preferences: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as User;
}

function renderWizardAt(
  initialStep: WizardStep,
  options: { allowClaudeOAuthSignIn?: boolean } = {}
) {
  agorStore.setState({ ...EMPTY_MAPS });
  const boardsService = {
    create: vi.fn(async (data: { board_id?: string }) => ({
      board_id: data.board_id,
      created_by: 'user-1',
    })),
  };
  const user = makeUser();
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) => {
      if (name === 'boards') return boardsService;
      if (name === 'users') return { get: vi.fn(async () => user) };
      return {
        on: vi.fn(),
        off: vi.fn(),
        get: vi.fn(async () => ({ state: 'no_auth' })),
        find: vi.fn(async () => ({ data: [] })),
      };
    }),
  };
  const props = {
    open: true,
    initialStep,
    onComplete: vi.fn(),
    user,
    client,
    onCreateRepo: vi.fn(async () => undefined),
    onCreateLocalRepo: vi.fn(),
    onCreateBranch: vi.fn(async () => null),
    onCreateSession: vi.fn(async () => null),
    onUpdateUser: vi.fn(async () => undefined),
    allowClaudeOAuthSignIn: options.allowClaudeOAuthSignIn,
  } as unknown as ComponentProps<typeof OnboardingWizard>;
  return render(
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
      <OnboardingWizard {...props} />
    </ConfigProvider>
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => {
  cleanup();
  agorStore.setState({ ...EMPTY_MAPS });
});

describe('OnboardingWizard layout (real browser)', () => {
  it('closes once and opens the created board when realtime completion wins the PATCH race', async () => {
    const user = makeUser();
    const transitions: boolean[] = [];
    let resolveCompletionWrite!: () => void;
    const completionWrite = new Promise<void>((resolve) => {
      resolveCompletionWrite = resolve;
    });
    const boardsService = {
      create: vi.fn(async (data: { board_id?: string }) => ({
        board_id: data.board_id,
        created_by: user.user_id,
      })),
    };
    const usersService = { get: vi.fn(async () => user) };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'users') return usersService;
        return {
          on: vi.fn(),
          off: vi.fn(),
          get: vi.fn(async () => ({ state: 'no_auth' })),
          find: vi.fn(async () => ({ data: [] })),
        };
      }),
    };
    const onUpdateUser = vi.fn(async () => undefined);
    const completionWrites = vi.fn(() => completionWrite);

    function Harness() {
      const [directoryUser, setDirectoryUser] = useState(user);
      const navigate = useNavigate();
      const location = useLocation();
      const lifecycle = useOnboardingLifecycle({
        userId: user.user_id,
        authenticationGeneration: 1,
        eligible: true,
        ready: true,
        // Authentication remains stale while a realtime directory update from
        // this/another tab supplies the close-only terminal signal.
        completed: hasObservedOnboardingCompletion(user, directoryUser),
        deferred: false,
        isAuthenticationOwnerCurrent: () => true,
      });
      useEffect(() => {
        if (transitions.at(-1) !== lifecycle.open) transitions.push(lifecycle.open);
      }, [lifecycle.open]);
      const owner = lifecycle.activeOwner;

      return (
        <>
          <button
            type="button"
            onClick={() => setDirectoryUser({ ...user, onboarding_completed: false })}
          >
            Publish stale incomplete user
          </button>
          <button
            type="button"
            onClick={() => setDirectoryUser({ ...user, onboarding_completed: true })}
          >
            Publish completed user
          </button>
          <output aria-label="Current path">{location.pathname}</output>
          <OnboardingWizard
            open={lifecycle.open}
            isCurrent={() => !!owner && lifecycle.isOwnerCurrent(owner)}
            user={user}
            client={client as never}
            onUpdateUser={onUpdateUser}
            onComplete={async (result) => {
              await completionWrites();
              // Mirrors App's post-commit sequence: realtime may have already
              // closed the automatic wizard before the PATCH promise resolves.
              if (owner && lifecycle.complete(owner)) {
                navigate(boardPath(result.boardId as BoardID));
              }
            }}
            onDismiss={() => {
              if (owner) lifecycle.defer(owner);
            }}
          />
        </>
      );
    }

    render(
      <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
        <MemoryRouter initialEntries={['/']}>
          <Harness />
        </MemoryRouter>
      </ConfigProvider>
    );
    await screen.findByText('Hi New, meet your teammate');
    fireEvent.click(screen.getByText(/skip for now/i).closest('button')!);
    await screen.findByText('Connect your AI');
    fireEvent.click(screen.getByText(/skip for now/i).closest('button')!);
    await screen.findByText('Connect your teammate');
    fireEvent.click(screen.getByText(/skip for now/i).closest('button')!);
    await screen.findByText('Your teammate is almost ready.');
    const closeRect = screen.getByRole('button', { name: 'Close' }).getBoundingClientRect();
    expect(closeRect.top).toBeGreaterThanOrEqual(0);
    expect(closeRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(closeRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    fireEvent.click(screen.getByText(/open my board/i).closest('button')!);

    await waitFor(() => expect(completionWrites).toHaveBeenCalledTimes(1));
    const createdBoardId = boardsService.create.mock.calls[0][0].board_id as BoardID;
    expect(screen.getByLabelText('Current path')).toHaveTextContent('/');
    fireEvent.click(screen.getByRole('button', { name: 'Publish completed user' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    act(() => resolveCompletionWrite());
    await waitFor(() =>
      expect(screen.getByLabelText('Current path')).toHaveTextContent(boardPath(createdBoardId))
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish stale incomplete user' }));
    await nextFrame();
    await nextFrame();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(transitions).toEqual([false, true, false]);
    expect(boardsService.create).toHaveBeenCalledTimes(1);
    expect(usersService.get).toHaveBeenCalledTimes(1);
    expect(onUpdateUser).toHaveBeenCalledTimes(1);
    expect(completionWrites).toHaveBeenCalledTimes(1);
  });

  it('lays the compact template cards out in three columns (two on phones)', async () => {
    renderWizardAt('workspace');
    const grid = await waitFor(() => {
      const element = document.querySelector(
        'fieldset[aria-label="Teammate template"]'
      ) as HTMLElement | null;
      expect(element, 'the card grid should exist').toBeTruthy();
      return element as HTMLElement;
    });

    // Chromium can preserve `repeat(auto-fit, minmax(...))` in computed style
    // at narrow viewports. Count the cards sharing the first rendered row
    // instead; this observes the layout result rather than its CSS spelling.
    // Skip the full-width Team assistant header row so the first template row is measured.
    const cardRects = Array.from(grid.querySelectorAll('[role="button"]'))
      .filter((card) => card.getAttribute('aria-label') !== 'Team assistant')
      .map((card) => card.getBoundingClientRect());
    const firstTop = cardRects[0]?.top;
    const renderedColumns = cardRects.filter((rect) => Math.abs(rect.top - firstTop) < 1).length;
    const expectedColumns = window.innerWidth <= 480 ? 2 : 3;
    expect(
      renderedColumns,
      `expected ${expectedColumns} gallery columns at ${window.innerWidth}px, got ${renderedColumns}: "${getComputedStyle(grid).gridTemplateColumns}"`
    ).toBe(expectedColumns);
  });

  it('keeps Claude and Codex recommendation labels accessible and inside their option buttons', async () => {
    renderWizardAt('llm');
    await screen.findByText('Connect your AI');

    expect(screen.getAllByText('Recommended')).toHaveLength(2);
    for (const title of ['Claude', 'GPT']) {
      const button = screen.getByRole('button', { name: new RegExp(`${title}.*Recommended`) });
      const badge = within(button).getByText('Recommended');
      await waitFor(() => expect(badge).toBeVisible());
      const badgeRect = badge.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      expect(badgeRect.left).toBeGreaterThanOrEqual(buttonRect.left);
      expect(badgeRect.right).toBeLessThanOrEqual(buttonRect.right);
      expect(badgeRect.top).toBeGreaterThanOrEqual(buttonRect.top);
      expect(badgeRect.bottom).toBeLessThanOrEqual(buttonRect.bottom);
    }
    for (const title of ['Gemini', 'Custom']) {
      const button = screen.getByRole('button', { name: new RegExp(title) });
      expect(within(button).queryByText('Recommended')).not.toBeInTheDocument();
    }
  });

  it('keeps all three Claude sign-in methods in an even row or narrow stacked layout', async () => {
    renderWizardAt('llm', { allowClaudeOAuthSignIn: true });
    fireEvent.click((await screen.findByText('Claude')).closest('button') as HTMLElement);

    const group = screen.getByRole('group', { name: 'Claude authentication method' });
    const buttons = Array.from(group.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual([
      'API key',
      'Sign in with Claude',
      'Subscription token',
    ]);
    const rects = buttons.map((button) => button.getBoundingClientRect());
    const renderedRows = new Set(rects.map((rect) => Math.round(rect.top))).size;
    expect(renderedRows).toBe(window.innerWidth <= 480 ? 3 : 1);
    expect(new Set(rects.map((rect) => Math.round(rect.width))).size).toBe(1);
    expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth + 1);
  });

  it('collapses the teammate step title on scroll and restores it at the top', async () => {
    renderWizardAt('workspace');
    await screen.findByText('Hi New, meet your teammate');

    const collapsible = document.querySelector('[data-collapsible-header]') as HTMLElement | null;
    expect(collapsible, 'the collapsible title+intro block should exist').toBeTruthy();
    expect(collapsible).toHaveClass('onb-workspace-collapsible');
    expect(
      Array.from(document.querySelectorAll('style')).some((style) =>
        style.textContent?.includes('.onb-workspace-collapsible { transition: none !important; }')
      ),
      'reduced-motion CSS should disable the scroll-driven collapse transition'
    ).toBe(true);
    const grid = document.querySelector(
      'fieldset[aria-label="Teammate template"]'
    ) as HTMLElement | null;
    const scroller = grid?.parentElement as HTMLElement | null;
    expect(scroller, 'the card scroll region should exist').toBeTruthy();
    if (!collapsible || !scroller) return;

    // Tall desktop viewports fit every card, so there is nothing to collapse.
    if (scroller.scrollHeight <= scroller.clientHeight) return;

    // At the top: the title ("Hi New, meet your teammate") + intro are visible.
    expect(document.body.textContent, 'the step title should be present at scroll top').toContain(
      'Hi New, meet your teammate'
    );
    expect(getComputedStyle(collapsible).opacity).toBe('1');
    expect(collapsible.getBoundingClientRect().height).toBeGreaterThan(0);

    // Scroll the card region past the threshold → title + intro collapse away.
    fireEvent.scroll(scroller, { target: { scrollTop: 120 } });
    await waitFor(() => {
      expect(getComputedStyle(collapsible).opacity).toBe('0');
      expect(
        collapsible.getBoundingClientRect().height,
        'the collapsed title/intro block should have zero rendered height'
      ).toBe(0);
    });

    // Scroll back to the top → title + intro reappear.
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await waitFor(() => {
      expect(getComputedStyle(collapsible).opacity).toBe('1');
      expect(collapsible.getBoundingClientRect().height).toBeGreaterThan(0);
    });
  });

  it('never lets a card overlap the pinned name field at any scroll offset', async () => {
    renderWizardAt('workspace');
    await screen.findByText('Hi New, meet your teammate');

    const nameField = document.querySelector(
      'input[aria-label="Teammate name"]'
    ) as HTMLElement | null;
    const grid = document.querySelector(
      'fieldset[aria-label="Teammate template"]'
    ) as HTMLElement | null;
    const scroller = grid?.parentElement as HTMLElement | null;
    expect(nameField && scroller, 'pinned header + scroller should exist').toBeTruthy();
    if (!nameField || !scroller) return;

    const cards = () => Array.from(document.querySelectorAll('.ant-card')) as HTMLElement[];
    expect(cards().length).toBeGreaterThan(4);

    // Sample a grid of points over the pinned name field at a
    // range of scroll offsets. elementFromPoint respects real paint/stacking
    // order, so a card painting over the header would be the hit element. Because
    // the grid is clipped to its own overflow box, that must never happen.
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const offsets = [0, 40, 90, 160, Math.max(0, maxScroll)].filter(
      (v, i, a) => a.indexOf(v) === i && v <= maxScroll
    );

    const overlaps: string[] = [];
    for (const top of offsets) {
      await act(async () => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event('scroll'));
        await nextFrame();
      });

      for (const region of [nameField]) {
        const rect = region.getBoundingClientRect();
        for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
          for (let fx = 0.1; fx <= 0.9; fx += 0.2) {
            const x = Math.round(rect.left + rect.width * fx);
            const y = Math.round(rect.top + rect.height * fy);
            const card = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(
              '.ant-card'
            );
            if (card) {
              overlaps.push(
                `scrollTop=${top} point=(${x},${y}) hit card "${card.getAttribute('aria-label')}"`
              );
            }
          }
        }
      }
    }

    expect(
      overlaps,
      `A gallery card painted over the pinned controls:\n${overlaps.join('\n')}`
    ).toEqual([]);
  });

  it('renders the success screen vertically centered, with no recap line and a celebratory hero', async () => {
    if (window.innerWidth < 700 || window.innerHeight < 800) return;
    renderWizardAt('workspace');

    // workspace → name + Product Manager template → continue
    await screen.findByText('Hi New, meet your teammate');
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    fireEvent.click(screen.getByText('Product Manager').closest('[role="button"]') as HTMLElement);
    fireEvent.click(screen.getByText(/^continue →/i).closest('button') as HTMLElement);

    // llm → connect Claude with a valid key
    const claude = await screen.findByText('Claude');
    fireEvent.click(claude.closest('button') as HTMLElement);
    const key = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: key } });
    fireEvent.click(screen.getByText(/^connect →/i).closest('button') as HTMLElement);

    await screen.findByText('Connect your teammate');
    fireEvent.click(screen.getByText(/^continue →/i).closest('button') as HTMLElement);

    // done — teammate-centric success screen.
    await screen.findByText('Rusty is almost ready.');

    // (1) Recap line is gone: the provider is not echoed here.
    expect(screen.queryByText('Claude')).toBeNull();

    const step = document.querySelector('.onb-step') as HTMLElement;

    // (3) Celebratory hero present: accent glow + one-shot ring + particle burst.
    expect(step.querySelector('.onb-glow'), 'the accent glow should render').toBeTruthy();
    expect(step.querySelector('.onb-ring'), 'the ring pulse should render').toBeTruthy();
    expect(step.querySelectorAll('.onb-particle').length).toBeGreaterThan(4);

    // (2) Vertically centered: the content block's top gap ≈ bottom gap within the
    // step body — not top-weighted with a large empty bottom half.
    const content = step.firstElementChild as HTMLElement;
    const s = step.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const topGap = c.top - s.top;
    const bottomGap = s.bottom - c.bottom;
    expect(
      Math.abs(topGap - bottomGap),
      `success content should be vertically centered (topGap=${topGap}, bottomGap=${bottomGap})`
    ).toBeLessThan(48);
  });

  it('keeps the modal and primary action inside every configured viewport', async () => {
    renderWizardAt('workspace');
    await screen.findByText('Hi New, meet your teammate');

    const modal = document.querySelector('.ant-modal') as HTMLElement | null;
    const primary = Array.from(document.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    );
    expect(modal, 'the modal should exist').toBeTruthy();
    expect(primary, 'the primary footer action should exist').toBeTruthy();
    if (!modal || !primary) return;

    const modalRect = modal.getBoundingClientRect();
    const primaryRect = primary.getBoundingClientRect();
    expect(modalRect.top).toBeGreaterThanOrEqual(0);
    expect(modalRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(modalRect.left).toBeGreaterThanOrEqual(0);
    expect(modalRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(primaryRect.top).toBeGreaterThanOrEqual(0);
    expect(primaryRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(primaryRect.left).toBeGreaterThanOrEqual(0);
    expect(primaryRect.right).toBeLessThanOrEqual(window.innerWidth);
  });
});
