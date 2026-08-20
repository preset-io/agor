/**
 * Real-browser (Playwright + system Chrome) layout regressions for the widened
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
import type { User } from '@agor-live/client';
import { render } from '@testing-library/react';
import { theme as antdTheme, ConfigProvider } from 'antd';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
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
    create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
  };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) => (name === 'boards' ? boardsService : {})),
  };
  const props = {
    open: true,
    initialStep,
    onComplete: vi.fn(),
    user: makeUser(),
    client,
    onCreateRepo: vi.fn(async () => undefined),
    onCreateLocalRepo: vi.fn(),
    onCreateBranch: vi.fn(async () => null),
    onCreateSession: vi.fn(async () => null),
    onUpdateUser: vi.fn(async () => undefined),
  } as unknown as ComponentProps<typeof OnboardingWizard>;
  return render(
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <OnboardingWizard {...props} />
    </ConfigProvider>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('OnboardingWizard layout (real browser)', () => {
  it('lays the step-2 teammate gallery out in exactly three columns at the widened modal', async () => {
    renderWizardAt('workspace');
    // Let the antd Modal portal + fonts/layout settle.
    await wait(300);

    const grid = document.querySelector(
      '[role="radiogroup"][aria-label="Teammate template"]'
    ) as HTMLElement | null;
    expect(grid, 'the card grid should exist').toBeTruthy();
    if (!grid) return;

    // getComputedStyle resolves the auto-fit template to explicit pixel tracks;
    // the count of tracks is the real rendered column count.
    const tracks = getComputedStyle(grid)
      .gridTemplateColumns.split(' ')
      .filter((track) => track.trim().length > 0);
    expect(
      tracks.length,
      `expected 3 gallery columns at the widened modal, got ${tracks.length}: "${getComputedStyle(grid).gridTemplateColumns}"`
    ).toBe(3);
  });

  it('renders every step-1 goal card title on a single line', async () => {
    renderWizardAt('goals');
    await wait(300);

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
    renderWizardAt('goals');
    await wait(300);

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
    renderWizardAt('workspace');
    await wait(300);

    const collapsible = document.querySelector('[data-collapsible-header]') as HTMLElement | null;
    expect(collapsible, 'the collapsible title+intro block should exist').toBeTruthy();
    const grid = document.querySelector(
      '[role="radiogroup"][aria-label="Teammate template"]'
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
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event('scroll'));
    await wait(350); // let the max-height/opacity transition finish

    expect(getComputedStyle(collapsible).opacity).toBe('0');
    expect(
      collapsible.getBoundingClientRect().height,
      'the collapsed title/intro block should have zero rendered height'
    ).toBe(0);

    // Scroll back to the top → title + intro reappear.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await wait(350);
    expect(getComputedStyle(collapsible).opacity).toBe('1');
    expect(collapsible.getBoundingClientRect().height).toBeGreaterThan(0);
  });

  it('never lets a card overlap the pinned name field / chips at any scroll offset', async () => {
    renderWizardAt('workspace');
    await wait(300);

    const chipGroup = document.querySelector(
      '[role="group"][aria-label="Filter templates by category"]'
    ) as HTMLElement | null;
    const nameField = document.querySelector(
      'input[aria-label="Teammate name"]'
    ) as HTMLElement | null;
    const grid = document.querySelector(
      '[role="radiogroup"][aria-label="Teammate template"]'
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
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event('scroll'));
      await wait(60);

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
});
