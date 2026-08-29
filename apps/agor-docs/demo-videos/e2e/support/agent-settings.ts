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
// different modal entirely). Both configuration steps below run inside one
// continuous modal session (the sidebar has both "Claude Code" and
// "Environment variables"), closed once by the caller via closeSettings().

import type { Page } from '@playwright/test';
import { moveToElement } from './cursor.ts';

/** Open the personal User Settings modal, landed on the AI Providers tab. */
export async function openConnectAi(page: Page): Promise<void> {
  await page.locator('button:has-text("Connect AI")').first().click();
  await page.waitForTimeout(500);
}

/** Paste a Claude subscription OAuth token (sk-ant-oat01-...) via the real Settings UI. */
export async function connectClaudeSubscription(page: Page, oauthToken: string): Promise<void> {
  await page.locator('text=Claude Code').first().click();
  await page.waitForTimeout(300);
  await page.locator('text=Claude subscription').first().click();

  const tokenInput = page.locator('input[placeholder*="sk-ant-oat" i]').first();
  await moveToElement(page, tokenInput);
  await tokenInput.fill(oauthToken);
  await page.locator('button:has-text("Save")').first().click();
  await page.waitForTimeout(500);
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
  await page.locator('text=Claude Code').first().click();
  await page.waitForTimeout(300);
  await page.locator('text=API key').first().click();
  await page.waitForTimeout(300);

  const authTokenInput = page.locator('input[placeholder="token..."]').first();
  await moveToElement(page, authTokenInput);
  await authTokenInput.fill(bearerToken);
  // Each ApiKeyFields row has its own adjacent Save button (Space.Compact).
  await page
    .locator('.ant-space-compact:has(input[placeholder="token..."]) button:has-text("Save")')
    .first()
    .click();
  await page.waitForTimeout(500);

  const baseUrlInput = page.locator('input[placeholder="https://api.anthropic.com"]').first();
  await moveToElement(page, baseUrlInput);
  await baseUrlInput.fill(baseUrl);
  await page
    .locator(
      '.ant-space-compact:has(input[placeholder="https://api.anthropic.com"]) button:has-text("Save")'
    )
    .first()
    .click();
  await page.waitForTimeout(500);
}

/** Add (or update) a global-scope environment variable via the real Settings UI. */
export async function addGlobalEnvVar(page: Page, name: string, value: string): Promise<void> {
  await page.locator('text=Environment var').first().click();
  await page.waitForTimeout(300);

  const nameInput = page.locator('input[placeholder*="Variable name" i]').first();
  await moveToElement(page, nameInput);
  await nameInput.fill(name);

  const valueInput = page.locator('input[placeholder="Value"]').first();
  await moveToElement(page, valueInput);
  await valueInput.fill(value);

  await page.locator('button:has-text("Add")').first().click();
  await page.waitForTimeout(500);
}

export async function closeSettings(page: Page): Promise<void> {
  const doneButton = page.locator('button:has-text("Done")').first();
  if (await doneButton.isVisible().catch(() => false)) {
    await doneButton.click();
  }
}
