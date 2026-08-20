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
});
