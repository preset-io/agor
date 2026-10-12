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

/** Glide the cursor down a list, resting briefly on each item (highlighting it). */
export async function skim(
  actor: Actor,
  items: Locator,
  count: number,
  restMs = 260
): Promise<void> {
  const n = Math.min(count, await items.count());
  for (let i = 0; i < n; i++) {
    await actor.glideTo(items.nth(i), 260);
    await actor.hold(restMs);
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
