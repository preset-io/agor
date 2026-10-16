// Lesson 03 — Connect your AI.
//
// The amber "No AI connected" banner has been telling the truth since first
// run: sessions open, but nothing runs. This lesson follows its Connect AI
// button into the real Settings flow, configures a Claude Code credential,
// and ends with the banner genuinely gone — the daemon's own auth probe
// verified the credential against the provider.
//
// Requires an agent mode (live records through the cassette proxy; replay
// serves the recorded probe response). Without one, this lesson skips —
// and so does everything downstream that talks to a model.

import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  closeSettings,
  configureClaudeProxiedAuth,
  openConnectAi,
} from '../../support/agent-settings.ts';
import { PROXY_URL, resolveAgentMode, SECRETS_FILE } from '../../support/harness.ts';
import { openLesson, settle } from '../../support/pacing.ts';

const agentMode = resolveAgentMode();

function loadOAuthToken(): string {
  if (!existsSync(SECRETS_FILE)) {
    throw new Error(`lesson 03: no secrets file at ${SECRETS_FILE} — add CLAUDE_CODE_OAUTH_TOKEN.`);
  }
  for (const line of readFileSync(SECRETS_FILE, 'utf-8').split('\n')) {
    if (line.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))
      return line.slice('CLAUDE_CODE_OAUTH_TOKEN='.length).trim();
  }
  throw new Error(`lesson 03: CLAUDE_CODE_OAUTH_TOKEN not found in ${SECRETS_FILE}.`);
}

test.skip(!agentMode, 'set AGOR_E2E_AGENT_MODE=live|replay for the AI lessons');

test('lesson 03: connect your AI', async ({ page }) => {
  // In replay mode the proxy never touches the network, so a placeholder is
  // enough — the recorded probe response vouches for it.
  const token = agentMode === 'live' ? loadOAuthToken() : 'sk-ant-oat01-replay-placeholder';

  await openLesson(page, '/', '03-connect-your-ai');
  await expect(page.locator('text=No AI connected').first()).toBeVisible({ timeout: 30_000 });

  await openConnectAi(page);
  await configureClaudeProxiedAuth(page, token, PROXY_URL);
  await closeSettings(page);

  // The daemon re-probes on credential save; a working credential clears
  // both amber banners for real.
  await expect(page.locator('text=No AI connected')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("text=credentials aren't working")).toBeHidden({ timeout: 20_000 });
  await settle(page);
});
