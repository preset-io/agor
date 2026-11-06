// Lesson 12 — Multiplayer.
//
// Boards are multiplayer surfaces: everyone sees the same canvas live,
// with presence cursors. This lesson creates a second user through the
// admin Settings UI (there is no email-invite flow — an admin creates the
// account), then that user joins the board in a second browser context:
// their live cursor appears with a name chip, and when they drag a branch
// card, it moves on the admin's screen in real time.
//
// The second context is driven headlessly and NOT recorded — the lesson's
// footage is the admin's point of view, which is where the multiplayer
// magic is visible. The second user's login happens over REST (login
// screens are never part of a recording).

import { expect, test } from '@playwright/test';
import { ADMIN_USER, BASE_URL, BOARD_PATH, DAEMON_URL } from '../../support/harness.ts';
import {
  beat,
  glideAndClick,
  glideTo,
  openLesson,
  pacedMove,
  settle,
  typeInto,
} from '../../support/pacing.ts';

// Password policy requires 15+ characters.
const GUEST = { name: 'Ada', email: 'ada@agor.live', password: 'sprinkles-and-glaze-42' } as const;
// The lesson-02 branch — present in every mode (the lesson-07 card only
// exists when the agent lessons ran).
const CARD_NAME = 'glaze-menu-refresh';

test('lesson 12: multiplayer — two people, live cursors, one board', async ({ page, browser }) => {
  test.setTimeout(300_000);
  await openLesson(page, BOARD_PATH, '12-multiplayer');
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // Add a second user: Settings (workspace) -> Admin -> Users -> New User.
  await glideAndClick(page, page.locator('[aria-label="Settings menu"]').first());
  await beat(page);
  await glideAndClick(page, page.locator('.ant-dropdown-menu-item:has-text("Settings")').first());
  await beat(page);
  const settingsModal = page.locator('.ant-modal').last();
  await glideAndClick(page, settingsModal.getByText('Users', { exact: true }).first());
  await beat(page);
  await glideAndClick(page, page.locator('button:has-text("New User")').first());

  const userModal = page.locator('.ant-modal:has-text("Create User")').last();
  await expect(userModal).toBeVisible({ timeout: 15_000 });
  await typeInto(page, userModal.locator('input[placeholder="John Doe"]').first(), GUEST.name);
  await typeInto(
    page,
    userModal.locator('input[placeholder="user@example.com"]').first(),
    GUEST.email
  );
  await typeInto(page, userModal.locator('input[type="password"]').first(), GUEST.password);
  // Skip the forced first-login password change — Ada joins immediately.
  const forceChange = userModal.locator('input[type="checkbox"]').last();
  if (await forceChange.isChecked()) {
    await glideAndClick(page, userModal.locator('text=Force password change').first());
  }
  await glideAndClick(page, userModal.locator('button:has-text("Create")').last());
  await expect(userModal).toBeHidden({ timeout: 15_000 });
  await settle(page);

  // Close settings — back to the board, now shared with Ada.
  await glideAndClick(
    page,
    page.locator('.ant-modal [aria-label="Close"], .ant-modal .ant-modal-close').first()
  );
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 15_000 });
  await settle(page);

  // Mark Ada's onboarding complete over REST (as admin) so her first load
  // opens the shared board, not her own onboarding wizard — her setup is
  // scaffolding, never footage. (Every new user otherwise gets the full
  // wizard, even when joining an existing workspace — see
  // ONBOARDING_FINDINGS.md #9.)
  const adminAuthRes = await fetch(`${DAEMON_URL}/authentication`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'local', ...ADMIN_USER }),
  });
  if (!adminAuthRes.ok) throw new Error(`lesson 12: admin login failed (${adminAuthRes.status})`);
  const adminToken = ((await adminAuthRes.json()) as { accessToken: string }).accessToken;
  const adminHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${adminToken}`,
  };
  const usersRes = await fetch(`${DAEMON_URL}/users`, { headers: adminHeaders });
  if (!usersRes.ok) throw new Error(`lesson 12: users lookup failed (${usersRes.status})`);
  const usersBody = (await usersRes.json()) as
    | { data?: { user_id: string; email: string }[] }
    | { user_id: string; email: string }[];
  const userRows = Array.isArray(usersBody) ? usersBody : (usersBody.data ?? []);
  const adaRow = userRows.find((u) => u.email === GUEST.email);
  if (!adaRow) throw new Error('lesson 12: created user not found via REST');
  const patchRes = await fetch(`${DAEMON_URL}/users/${adaRow.user_id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ onboarding_completed: true }),
  });
  if (!patchRes.ok) throw new Error(`lesson 12: onboarding patch failed (${patchRes.status})`);

  // Ada signs in over REST and opens the same board in her own browser.
  const authRes = await fetch(`${DAEMON_URL}/authentication`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'local', email: GUEST.email, password: GUEST.password }),
  });
  if (!authRes.ok) throw new Error(`lesson 12: guest login failed (${authRes.status})`);
  const auth = (await authRes.json()) as { accessToken?: string; refreshToken?: string };
  if (!auth.accessToken) throw new Error('lesson 12: guest login returned no accessToken');
  const guestStorage = [{ name: 'agor-access-token', value: auth.accessToken }];
  if (auth.refreshToken)
    guestStorage.push({ name: 'agor-refresh-token', value: auth.refreshToken });

  const guestContext = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    storageState: { cookies: [], origins: [{ origin: BASE_URL, localStorage: guestStorage }] },
  });
  const guest = await guestContext.newPage();
  // Hoisted so `finally` can always stop the background wiggle loop — a
  // failure mid-loop must not leave it spinning against a closed page.
  let adaMoving = false;
  let adaWiggle: Promise<void> = Promise.resolve();
  try {
    await guest.goto(BOARD_PATH);
    await expect(guest.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });

    // Her onboarding was completed over REST above — the wizard must not
    // appear over her board.
    await expect(guest.locator('text=what do you want to get done')).toBeHidden();

    // Ada's cursor goes live the moment she moves — and unmounts after 5s
    // of stillness, so keep her gently in motion in the background for the
    // whole admin-side beat (never glide to her chip by locator: it
    // flickers with her movement and a scroll-into-view on it can hang).
    await guest.mouse.move(960, 540);
    adaMoving = true;
    adaWiggle = (async () => {
      for (let i = 0; adaMoving; i++) {
        const dx = (i % 2 === 0 ? 1 : -1) * 55;
        await pacedMove(guest, 1250 + dx, 490 + (i % 3) * 30, 650).catch(() => undefined);
      }
    })();

    // On the admin's screen: a live remote cursor with Ada's name chip.
    const adaChip = page.getByText(GUEST.name, { exact: true }).first();
    await expect(adaChip).toBeVisible({ timeout: 20_000 });
    // Admin glides over to meet her — two live cursors sharing one canvas.
    await pacedMove(page, 1250, 640, 900);
    await settle(page);
    adaMoving = false;
    await adaWiggle;

    // Both people, one canvas: Ada drags the daily-special branch card and
    // it moves live on the admin's board.
    const guestCard = guest.locator(`.react-flow__node:has-text("${CARD_NAME}")`).first();
    await expect(guestCard).toBeVisible({ timeout: 15_000 });
    const box = await guestCard.boundingBox();
    if (!box) throw new Error('lesson 12: card not on guest screen');
    await pacedMove(guest, box.x + box.width / 2, box.y + 10, 800);
    await guest.mouse.down();
    await pacedMove(guest, box.x + box.width / 2 + 260, box.y + 190, 1300);
    await guest.mouse.up();
    await settle(page);

    // End wide on the admin's view: the card in its new spot, Ada's cursor
    // hovering beside it.
    const adminCard = page.locator(`.react-flow__node:has-text("${CARD_NAME}")`).first();
    await expect(adminCard).toBeVisible({ timeout: 15_000 });
    await pacedMove(guest, box.x + box.width / 2 + 320, box.y + 160, 700);
    await glideTo(page, adminCard);
    await expect(adaChip).toBeVisible({ timeout: 5_000 });
    await settle(page);
  } finally {
    adaMoving = false;
    await adaWiggle.catch(() => undefined);
    await guestContext.close();
  }
});
