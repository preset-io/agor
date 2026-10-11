// Drives the REAL User Settings UI to configure a live agent credential and
// a proxy override — the sanctioned path, not a shortcut: Agor resolves
// agentic-tool credentials from the database (per-user or per-tenant), not
// from daemon env vars (packages/core/src/config/key-resolver.ts —
// "Local synchronous credential fallback was removed with global provider
// config"). A generic per-user env var (Settings -> Environment variables,
// 'global' scope) is the sanctioned way to project an arbitrary var like
// ANTHROPIC_BASE_URL into every session's executor
// (packages/core/src/config/env-resolver.ts resolveUserEnvironment) — no
// daemon-side allowlist change needed, since it's the user's own opt-in
// data rather than ambient daemon env leakage.
//
// Entry point is the dashboard's "Connect AI" banner button, which routes
// to the PERSONAL User Settings' AI Providers tab (as opposed to the
// top-nav gear menu's "Settings", which opens WORKSPACE settings — a
// different modal entirely).
//
// Pacing: these run inside recorded lessons, so every interaction uses the
// pacing verbs. Secrets are PASTED (a human pastes a 108-char token, they
// don't type it) but with deliberate pauses around the paste so a viewer
// sees the field fill; non-secret values are typed at demo cadence.

import type { Locator, Page } from '@playwright/test';
import { beat, glideAndClick, glideTo, settle, typeInto } from './pacing.ts';

/** Paste into a field the way a person does: click, breathe, paste, breathe. */
async function pasteInto(page: Page, field: Locator, value: string): Promise<void> {
  await glideAndClick(page, field);
  await beat(page);
  await field.fill(value);
  await beat(page);
}

/** Open the personal User Settings modal, landed on the AI Providers tab. */
export async function openConnectAi(page: Page): Promise<void> {
  await glideAndClick(page, page.locator('button:has-text("Connect AI")').first());
  await beat(page);
}

/** Paste a Claude subscription OAuth token (sk-ant-oat01-...) via the real Settings UI. */
export async function connectClaudeSubscription(page: Page, oauthToken: string): Promise<void> {
  await glideAndClick(page, page.locator('text=Claude Code').first());
  await beat(page);
  await glideAndClick(page, page.locator('text=Claude subscription').first());
  await beat(page);

  await pasteInto(page, page.locator('input[placeholder*="sk-ant-oat" i]').first(), oauthToken);
  await glideAndClick(page, page.locator('button:has-text("Save")').first());
  await settle(page);
}

/**
 * Configure Claude Code with a bearer token + base-URL override via the real
 * Settings UI's API-key sign-in path.
 *
 * Why not connectClaudeSubscription + a base-URL env var: Agor treats
 * ANTHROPIC_BASE_URL as part of the atomic provider connection
 * (PROVIDER_CONNECTION_FIELDS in packages/core/src/types/tenant-agentic-tool.ts),
 * so the executor's credential isolation strips it from the generic
 * environment, and the SUBSCRIPTION sign-in method's resolved connection
 * deliberately carries only CLAUDE_CODE_OAUTH_TOKEN
 * (tenant-agentic-tool-resolver.ts) — a base URL can never ride along with
 * subscription auth. The API-key method's connection carries every stored
 * field (auth token + base URL included), and a Claude subscription OAuth
 * token authenticates fine as the generic ANTHROPIC_AUTH_TOKEN bearer
 * (verified empirically) — so this is the sanctioned way to route a real
 * agent turn through the cassette proxy.
 */
export async function configureClaudeProxiedAuth(
  page: Page,
  bearerToken: string,
  baseUrl: string
): Promise<void> {
  await glideAndClick(page, page.locator('text=Claude Code').first());
  await beat(page);
  await glideAndClick(page, page.locator('text=API key').first());
  await beat(page);

  // Base URL FIRST, token second — every agentic_tools save bumps the app's
  // credentialVersion and re-fires the check-auth probe, and the probe hits
  // the connection's base URL (check-auth.ts). Saving in this order means
  // the probe triggered by the token save already routes through the
  // cassette proxy, so live mode records it and replay mode can serve it —
  // which is what clears the "credentials aren't working" banner in both.
  // A URL isn't a secret — type it at demo cadence.
  const baseUrlInput = page.locator('input[placeholder="https://api.anthropic.com"]').first();
  await typeInto(page, baseUrlInput, baseUrl);
  // Each ApiKeyFields row has its own adjacent Save button (Space.Compact).
  await glideAndClick(
    page,
    page
      .locator(
        '.ant-space-compact:has(input[placeholder="https://api.anthropic.com"]) button:has-text("Save")'
      )
      .first()
  );
  await settle(page);

  await pasteInto(page, page.locator('input[placeholder="token..."]').first(), bearerToken);
  await glideAndClick(
    page,
    page
      .locator('.ant-space-compact:has(input[placeholder="token..."]) button:has-text("Save")')
      .first()
  );
  // Let the saved state land on screen (the field flips to its "Set" pill).
  await settle(page);
}

/** Add (or update) a global-scope environment variable via the real Settings UI. */
export async function addGlobalEnvVar(page: Page, name: string, value: string): Promise<void> {
  await glideAndClick(page, page.locator('text=Environment var').first());
  await beat(page);

  await typeInto(page, page.locator('input[placeholder*="Variable name" i]').first(), name);
  await typeInto(page, page.locator('input[placeholder="Value"]').first(), value);
  await glideAndClick(page, page.locator('button:has-text("Add")').first());
  await settle(page);
}

export async function closeSettings(page: Page): Promise<void> {
  const doneButton = page.locator('button:has-text("Done")').first();
  if (await doneButton.isVisible().catch(() => false)) {
    await glideTo(page, doneButton);
    await beat(page);
    await doneButton.click();
    await beat(page);
  }
}
