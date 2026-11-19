// Shared beats for the "Raise AI teammates together" clips (seed:
// teammates-together). Each clip is one pillar of the montage; the edit
// (Remotion) does the zooms, so these clips export raw with marks.

import type { Locator } from '@playwright/test';
import type { Actor } from './studio.ts';

/** The open Ant Design select dropdown's options. */
export function dropdownOptions(actor: Actor): Locator {
  return actor.page.locator(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'
  );
}

/**
 * Drift the cursor over the first `count` items in one smooth, unhurried
 * motion (about `msPerItem` each), lighting each one's hover state on the
 * way, the way a hand browses: never hopping item to item. A grid is walked
 * row by row, snaking (left to right, then back right to left).
 */
export async function skim(
  actor: Actor,
  items: Locator,
  count: number,
  msPerItem = 300
): Promise<void> {
  const n = Math.min(count, await items.count());
  const boxes = (await Promise.all(Array.from({ length: n }, (_, i) => items.nth(i).boundingBox())))
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .map((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
  const rows: Array<typeof boxes> = [];
  for (const c of boxes) {
    const row = rows.find((r) => Math.abs(r[0].y - c.y) < 20);
    if (row) row.push(c);
    else rows.push([c]);
  }
  const points = rows.flatMap((r, i) => {
    const sorted = [...r].sort((a, b) => a.x - b.x);
    return i % 2 === 0 ? sorted : sorted.reverse();
  });
  await actor.path(points, n * msPerItem);
}

/** Scroll the page under the cursor smoothly: `dy` px in small wheel steps over `ms`. */
export async function smoothWheel(actor: Actor, dy: number, ms = 600): Promise<void> {
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    await actor.page.mouse.wheel(0, dy / steps);
    await actor.page.waitForTimeout(ms / steps);
  }
}

/** Pick an option from the open (searchable) dropdown, typing to filter if it isn't in view. */
export async function pickOption(actor: Actor, text: string, search = text): Promise<void> {
  const option = dropdownOptions(actor).filter({ hasText: text }).first();
  if (!(await option.isVisible())) {
    await actor.page.keyboard.type(search, { delay: 70 });
    await actor.hold(500);
  }
  await actor.click(option);
}

/** Open a teammate's settings (Settings → Teammates → Edit) on a tab. */
export async function openTeammate(actor: Actor, name: string, tab: string): Promise<void> {
  const p = actor.page;
  await actor.click(p.locator(`tr:has-text("${name}")`).getByLabel('Edit teammate').first());
  await actor.hold(600);
  await actor.click(p.getByRole('tab', { name: tab }).first());
  await actor.hold(700);
}
