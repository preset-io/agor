// Real-Agor E2E: a genuine live Claude Code turn — real credential, real
// session composer, real streamed response — recorded/replayed through the
// cassette proxy (see support/cassette-proxy.ts).
//
// Skipped unless AGOR_E2E_AGENT_MODE=live|replay:
//   pnpm test:live    — makes one real, cheap Anthropic call and records a
//                        cassette to ./cassettes/live-agent-session.json
//                        (commit the cassette after a successful live run)
//   pnpm test:replay  — replays the committed cassette, no network/cost
//
// Every other spec in this suite runs with no agent mode set and never
// touches this file's setup path (credentials, proxy) at all.

import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  closeSettings,
  configureClaudeProxiedAuth,
  openConnectAi,
} from '../support/agent-settings.ts';
import { loginAs } from '../support/auth.ts';
import { installCursor, moveToElement } from '../support/cursor.ts';
import { DEMO_USERS, PROXY_URL, resolveAgentMode, SECRETS_FILE } from '../support/harness.ts';

const agentMode = resolveAgentMode();

function loadOAuthToken(): string {
  if (!existsSync(SECRETS_FILE)) {
    throw new Error(
      `live-agent-session: no secrets file at ${SECRETS_FILE}. Add CLAUDE_CODE_OAUTH_TOKEN there first ` +
        '(see support/harness.ts loadSecrets doc comment).'
    );
  }
  for (const line of readFileSync(SECRETS_FILE, 'utf-8').split('\n')) {
    if (line.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))
      return line.slice('CLAUDE_CODE_OAUTH_TOKEN='.length).trim();
  }
  throw new Error(`live-agent-session: CLAUDE_CODE_OAUTH_TOKEN not found in ${SECRETS_FILE}.`);
}

test.skip(
  !agentMode,
  'set AGOR_E2E_AGENT_MODE=live|replay to run a real agent turn (see pnpm test:live/test:replay)'
);

test('a real Claude Code turn streams a real response', async ({ page }) => {
  // In replay mode the proxy never touches the network, so a syntactically
  // real-looking placeholder is enough — the SDK just needs something
  // token-shaped to attempt a call with.
  const oauthToken = agentMode === 'live' ? loadOAuthToken() : 'sk-ant-oat01-replay-placeholder';

  await loginAs(page, DEMO_USERS.alice);

  await openConnectAi(page);
  // API-key sign-in method with the OAuth token as the bearer + the proxy as
  // base URL — the only combination whose resolved connection carries a
  // base-URL override into the executor (see configureClaudeProxiedAuth).
  await configureClaudeProxiedAuth(page, oauthToken, PROXY_URL);
  await closeSettings(page);

  // The credential banners must genuinely clear: the token save re-fires the
  // daemon's check-auth probe, which validates the bearer token against the
  // connection's base URL (live: recorded through the proxy; replay: served
  // from the cassette). If either amber banner is still up, the run doesn't
  // look real and the credential plumbing regressed.
  await expect(page.locator('text=No AI connected')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("text=credentials aren't working")).toBeHidden({ timeout: 20_000 });

  // The seeded "Fix navbar layout (spawned)" session (fixtureData.ts /
  // demo-fixtures.ts) is IDLE — a real, promptable claude-code session.
  const sessionRow = page.locator('text=Fix navbar layout (spawned)').first();
  await moveToElement(page, sessionRow);
  await sessionRow.click();
  await page.waitForSelector('text=IDLE', { timeout: 15_000 });
  await installCursor(page);

  const composer = page.locator('textarea[placeholder*="Prompt here" i]').first();
  await moveToElement(page, composer);
  await composer.click();
  // The expected ANSWER must not appear anywhere in the prompt: the prompt
  // itself echoes into the transcript (twice — task header + message bubble)
  // the instant Send is clicked, so asserting on a word the prompt contains
  // passes before any model reply exists. (Learned the hard way: a first cut
  // asked for "PONG" verbatim and green-lit a run whose task was actually
  // SIGTERM'd mid-call by teardown, with zero assistant messages in the DB.)
  const prompt = 'Name the planet we live on. Reply with exactly one lowercase word.';
  await page.keyboard.type(prompt, { delay: 20 });

  const sendButton = page.locator('button:has-text("Send")').first();
  await moveToElement(page, sendButton);
  await sendButton.click();

  // Real (or replayed) streamed model output landing in the transcript —
  // this word can only come from the assistant's reply.
  await expect(page.locator('text=earth').first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1500); // hold on the payoff for the recorded video
});
