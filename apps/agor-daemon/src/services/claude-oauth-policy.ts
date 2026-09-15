import { createHash } from 'node:crypto';

// Constants are the PROD OAuth config read out of the native `claude` binary
// bundled by the pinned SDK: package.json pins
// @anthropic-ai/claude-agent-sdk@0.3.259, whose manifest.json bundles claude
// CLI v2.1.259 (commit 9b549c8d). The URLs, client id, redirect, scope set, and
// JSON authorization-code exchange were re-checked in that native binary for
// this upgrade. The `-local-oauth` config (client id 22422756-…,
// localhost:8205) is dev-only and deliberately not used here.
/** PROD OAuth client id (`yol.CLIENT_ID`). Fixed and public across installs. */
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Subscription (Claude Pro/Max) authorize endpoint = `yol.CLAUDE_AI_AUTHORIZE_URL`.
// Console/API-billing login uses `yol.CONSOLE_AUTHORIZE_URL`
// (https://platform.claude.com/oauth/authorize); the subscription path is ours.
export const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
// `yol.TOKEN_URL`. The old console.anthropic.com host belonged to pre-rename
// SDKs; prod issues and exchanges against platform.claude.com.
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// `yol.MANUAL_REDIRECT_URL` — the paste-back redirect. The CLI's own browser
// flow can instead use a loopback http://localhost:{port}/callback; the daemon
// runs no loopback server, so it uses the manual redirect, and the token is
// issued for exactly this redirect + client id, so both must match byte-for-byte.
export const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// Scope string the CLI's claude.ai login sends. `user:file_upload` was added by
// the CLI bundled with Agent SDK 0.3.259; omitting it would leave a successful
// Agor sign-in less capable than `/login` in the same CLI.
export const CLAUDE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

export const CLAUDE_OAUTH_BINDING = createHash('sha256')
  .update(
    JSON.stringify([
      'claude-code',
      1,
      CLAUDE_CLIENT_ID,
      CLAUDE_TOKEN_URL,
      CLAUDE_REDIRECT_URI,
      CLAUDE_SCOPES,
    ])
  )
  .digest('hex');
