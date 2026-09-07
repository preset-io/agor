/**
 * Real-browser (Playwright + Chromium) layout regressions for the widened
 * onboarding modal. jsdom can't resolve `grid-template-columns` to real track
 * pixels or measure wrapped text height, so these must run in an actual browser:
 *
 *  1. Step 2's teammate gallery lays out as exactly THREE columns at the widened
 *     (730px) modal — the whole point of the widen-the-modal pass.
 *  2. Every step-1 goal card TITLE renders on a single line at the step-1
 *     (explicit 2-column) card width — the copy pass depends on this.
 *
 * Run: pnpm vitest run --config vitest.browser.config.ts
 */
import { type BoardID, boardPath, type User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderWizardAt(initialStep: WizardStep) {
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
      return {};
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
        return {};
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
    await screen.findByText(/what do you want to get done/i);

    fireEvent.click(screen.getByText(/skip for now/i).closest('button')!);
    await screen.findByText('Build your teammate');
    fireEvent.click(screen.getByText(/skip for now/i).closest('button')!);
    await screen.findByText('Connect your AI');
    fireEvent.click(screen.getByText(/skip for now/i).closest('button')!);
    await screen.findByText('Connect your tools');
    fireEvent.click(screen.getByText(/skip for now/i).closest('button')!);
    await screen.findByText("You're ready to build.");
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

  it('lays the step-2 teammate gallery out in exactly three columns at the widened modal', async () => {
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
    const cardRects = Array.from(grid.children, (card) => card.getBoundingClientRect());
    const firstTop = cardRects[0]?.top;
    const renderedColumns = cardRects.filter((rect) => Math.abs(rect.top - firstTop) < 1).length;
    const expectedColumns = window.innerWidth <= 480 ? 1 : 3;
    expect(
      renderedColumns,
      `expected ${expectedColumns} gallery columns at ${window.innerWidth}px, got ${renderedColumns}: "${getComputedStyle(grid).gridTemplateColumns}"`
    ).toBe(expectedColumns);
  });

  it('renders every step-1 goal card title on a single line', async () => {
    renderWizardAt('goals');
    await screen.findByText('Get a personal teammate');

    const cards = Array.from(document.querySelectorAll('button.onb-card')) as HTMLElement[];
    expect(cards.length, 'the six goal cards should render').toBe(6);

    const offenders: string[] = [];
    for (const card of cards) {
      // The title is the first child <div> of the card button (description is the
      // second). Measure its rendered height against one line-height.
      const title = card.querySelector('div') as HTMLElement | null;
      if (!title) continue;
      const lineHeightPx = Number.parseFloat(getComputedStyle(title).lineHeight);
      const lines = Math.round(title.scrollHeight / lineHeightPx);
      if (lines > 1) {
        offenders.push(`"${title.textContent}" wrapped to ${lines} lines`);
      }
    }

    expect(offenders, `goal titles must stay one line:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('fits all six step-1 goal cards without internal scroll, clear of the footer', async () => {
    if (window.innerWidth < 700 || window.innerHeight < 800) return;
    renderWizardAt('goals');
    await screen.findByText('Get a personal teammate');

    // The step-1 content region (.onb-step) must not need to scroll: all six
    // cards + the title/intro fit inside its fixed height. scrollHeight beyond
    // clientHeight means the bottom card row is clipped and an internal scrollbar
    // appears — exactly the bug this padding pass fixes.
    const step = document.querySelector('.onb-step') as HTMLElement | null;
    expect(step, 'the step-1 content region (.onb-step) should exist').toBeTruthy();
    if (!step) return;
    expect(
      step.scrollHeight,
      `goal cards overflow their container (scrollHeight ${step.scrollHeight} > clientHeight ${step.clientHeight}) → internal scroll`
    ).toBeLessThanOrEqual(step.clientHeight + 1);

    // And the last card must sit fully above the pinned Back/Continue footer.
    const cards = Array.from(document.querySelectorAll('button.onb-card')) as HTMLElement[];
    expect(cards.length).toBe(6);
    const lastCardBottom = cards[cards.length - 1].getBoundingClientRect().bottom;
    const continueBtn = Array.from(document.querySelectorAll('button')).find((btn) =>
      /continue/i.test(btn.textContent ?? '')
    );
    expect(continueBtn, 'the footer Continue button should exist').toBeTruthy();
    if (!continueBtn) return;
    expect(
      lastCardBottom,
      'the last goal card must end above the pinned footer, not under it'
    ).toBeLessThanOrEqual(continueBtn.getBoundingClientRect().top + 1);
  });

  it('collapses the step-2 title + intro on scroll and restores it at the top', async () => {
    // Short/mobile layouts deliberately hide the intro so the useful controls
    // get the available height. The collapse animation is a desktop contract.
    if (window.innerWidth < 700 || window.innerHeight < 800) return;
    renderWizardAt('workspace');
    await screen.findByText('Build your teammate');

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

    // The card region must actually be scrollable (else there's nothing to test).
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);

    // At the top: the title ("Build your teammate") + intro are visible.
    expect(document.body.textContent, 'the step title should be present at scroll top').toContain(
      'Build your teammate'
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

  it('never lets a card overlap the pinned name field / chips at any scroll offset', async () => {
    renderWizardAt('workspace');
    await screen.findByText('Build your teammate');

    const chipGroup = document.querySelector(
      '[role="radiogroup"][aria-label="Filter templates by category"]'
    ) as HTMLElement | null;
    const nameField = document.querySelector(
      'input[aria-label="Teammate name"]'
    ) as HTMLElement | null;
    const grid = document.querySelector(
      'fieldset[aria-label="Teammate template"]'
    ) as HTMLElement | null;
    const scroller = grid?.parentElement as HTMLElement | null;
    expect(
      chipGroup && nameField && scroller,
      'pinned header + scroller should exist'
    ).toBeTruthy();
    if (!chipGroup || !nameField || !scroller) return;

    const cards = () => Array.from(document.querySelectorAll('.ant-card')) as HTMLElement[];
    expect(cards().length).toBeGreaterThan(4);

    // Sample a grid of points over BOTH pinned controls (name field + chips) at a
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

      for (const region of [nameField, chipGroup]) {
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
    renderWizardAt('goals');
    await screen.findByText('Get a personal teammate');

    // goals → pick one → continue
    fireEvent.click(screen.getByText('Ship without the busywork').closest('button') as HTMLElement);
    fireEvent.click((await screen.findByText(/^continue →/i)).closest('button') as HTMLElement);

    // workspace → name + Product Manager template → continue
    await screen.findByText('Build your teammate');
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    fireEvent.click(screen.getByText('Product Manager').closest('[role="button"]') as HTMLElement);
    fireEvent.click(screen.getByText(/^continue →/i).closest('button') as HTMLElement);

    // llm → connect Claude with a valid key
    const claude = await screen.findByText('Claude');
    fireEvent.click(claude.closest('button') as HTMLElement);
    const key = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: key } });
    fireEvent.click(screen.getByText(/^connect →/i).closest('button') as HTMLElement);

    // done — teammate-centric success screen.
    await screen.findByText('Rusty is ready.');

    // (1) Recap line is gone: neither the provider nor the goal is echoed here.
    expect(screen.queryByText('Claude')).toBeNull();
    expect(screen.queryByText('Ship without the busywork')).toBeNull();

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
    renderWizardAt('goals');
    await screen.findByText('Get a personal teammate');

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
