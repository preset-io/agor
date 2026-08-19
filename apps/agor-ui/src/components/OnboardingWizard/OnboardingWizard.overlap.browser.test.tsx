/**
 * Real-browser (Playwright + system Chrome) regression test for the step-2
 * "cards overlap the sticky controls" bug. jsdom can't model `position: sticky`
 * paint order or stacking contexts, so a jsdom/CSS harness passed while the bug
 * persisted live — this test mounts the ACTUAL OnboardingWizard on step 2 in a
 * real browser, scrolls the card region, and asserts (via elementFromPoint, which
 * respects real paint/stacking order) that no gallery card ever paints on top of
 * the pinned controls at any scroll offset.
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
import { OnboardingWizard } from './OnboardingWizard';

// The real emoji picker pulls a heavy dataset; stub it to a plain button so the
// wizard mounts fast. Its layout footprint is irrelevant to the stacking test.
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

function renderWizardAtWorkspace() {
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
    initialStep: 'workspace',
    onComplete: vi.fn(),
    user: makeUser(),
    client,
    onCreateRepo: vi.fn(async () => undefined),
    onCreateLocalRepo: vi.fn(),
    onCreateBranch: vi.fn(async () => null),
    onCreateSession: vi.fn(async () => null),
    onUpdateUser: vi.fn(async () => undefined),
  } as unknown as ComponentProps<typeof OnboardingWizard>;
  // Match the app: the wizard is mounted under a dark-algorithm ConfigProvider
  // (App.tsx). The theme drives the modal surface color the sticky header must
  // match, so faithfully reproducing it is essential.
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

describe('OnboardingWizard step 2 — sticky controls vs scrolling cards (real browser)', () => {
  it('never lets a gallery card paint over the pinned name/label/chips at any scroll offset', async () => {
    renderWizardAtWorkspace();
    // Let antd Modal portal + fonts/layout settle.
    await wait(300);

    const scroller = document.querySelector('.onb-step') as HTMLElement | null;
    expect(scroller, 'the step-2 scroll container (.onb-step) should exist').toBeTruthy();
    if (!scroller) return;

    // The sticky controls block is the container of the filter-chips group.
    const chipGroup = document.querySelector(
      '[role="group"][aria-label="Filter templates by category"]'
    ) as HTMLElement | null;
    expect(chipGroup, 'the filter chips group should exist').toBeTruthy();
    if (!chipGroup) return;
    const sticky = chipGroup.parentElement as HTMLElement;

    const grid = document.querySelector(
      '[role="radiogroup"][aria-label="Teammate template"]'
    ) as HTMLElement | null;
    expect(grid, 'the card grid should exist').toBeTruthy();
    if (!grid) return;

    const cards = () => Array.from(document.querySelectorAll('.ant-card')) as HTMLElement[];
    expect(cards().length).toBeGreaterThan(4);

    // Sanity: the sticky is actually pinned, opaque, and above the grid.
    expect(getComputedStyle(sticky).position).toBe('sticky');
    // biome-ignore lint/plugin/noHardcodedColorLiteral: asserts the computed sticky background is not the fully-transparent sentinel — not a UI color
    expect(getComputedStyle(sticky).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');

    // ── Structural guarantee (fails on the unfixed code) ──────────────────────
    // The overlap is a stacking-context defect: antd Cards are `position: relative`
    // and become z-indexed on hover, so in some engines a scrolled card can paint
    // over the sticky header (z-index:2). Confining the grid to its OWN stacking
    // context (`isolation: isolate`) makes it impossible by construction — every
    // card is trapped below the grid's context, which sits below the sticky.
    expect(
      getComputedStyle(grid).isolation,
      'the card grid must isolate its stacking context so cards can never paint above the sticky'
    ).toBe('isolate');

    // Scroll the card region through a range of offsets. At each offset, sample a
    // grid of points across the pinned sticky region; elementFromPoint respects
    // real paint order, so if a card is painting over the controls it will be the
    // hit element. A correctly-stacked sticky always returns the sticky (or its
    // descendants: inputs, labels, chips) — never a card.
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const offsets = [0, 40, 90, 140, 200, 260, 320, Math.max(0, maxScroll)].filter(
      (v, i, a) => a.indexOf(v) === i && v <= maxScroll
    );

    const overlaps: string[] = [];
    for (const top of offsets) {
      scroller.scrollTop = top;
      await wait(60);

      const s = sticky.getBoundingClientRect();
      // Sample inside the sticky region (inset a little from the edges).
      for (let fy = 0.15; fy <= 0.85; fy += 0.175) {
        for (let fx = 0.1; fx <= 0.9; fx += 0.2) {
          const x = Math.round(s.left + s.width * fx);
          const y = Math.round(s.top + s.height * fy);
          const hit = document.elementFromPoint(x, y) as HTMLElement | null;
          if (hit?.closest('.ant-card')) {
            const card = hit.closest('.ant-card') as HTMLElement;
            overlaps.push(
              `scrollTop=${top} point=(${x},${y}) hit card "${card.getAttribute('aria-label')}"`
            );
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
