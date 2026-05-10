/**
 * MCP probe template resolution.
 *
 * The `/mcp-servers/discover` endpoint runs in the daemon process, whose
 * `process.env` never holds user secrets — those live encrypted in the
 * users table. So the daemon can't reuse the executor's "read process.env
 * tagged with AGOR_USER_ENV_KEYS" path verbatim. Instead, callers load the
 * user's env vars from the DB and hand them to this helper, which builds
 * the same template context the executor uses (synthesizing the
 * AGOR_USER_ENV_KEYS tag so `buildMCPTemplateContextFromEnv` exposes the
 * right keys) and runs the resolver.
 *
 * Returning a discriminated union with a human-readable error keeps the
 * endpoint flow straightforward: on `ok: false` the caller returns the
 * error string to the UI; on `ok: true` it uses `resolved` for the probe.
 */

import { AGOR_USER_ENV_KEYS_VAR } from '@agor/core/config';
import { buildMCPTemplateContextFromEnv, resolveMcpServerTemplates } from '@agor/core/mcp';
import type { MCPAuth, MCPServer, MCPServerID, MCPTransport } from '@agor/core/types';

export interface ProbeServerConfig {
  url: string;
  transport: MCPTransport;
  auth?: MCPAuth;
  name?: string;
  /** Optional MCP server id (when probing an existing saved server). */
  mcpServerId?: string;
}

export type ProbeTemplateResult =
  | { ok: true; resolved: ProbeServerConfig }
  | { ok: false; error: string };

/**
 * Resolve `{{ user.env.X }}` templates in a probe MCP server config.
 *
 * @param serverConfig - probe target (url + auth + transport)
 * @param userEnv      - decrypted user env vars (Record<key, value>); usually
 *                       the result of `resolveUserEnvironment(userId, db)`
 * @returns ok+resolved when all templates resolved cleanly, or ok:false with
 *          an actionable error string otherwise.
 */
export function resolveProbeServerTemplates(
  serverConfig: ProbeServerConfig,
  userEnv: Record<string, string>
): ProbeTemplateResult {
  // Tag the synthetic env with AGOR_USER_ENV_KEYS so
  // buildMCPTemplateContextFromEnv knows which keys to expose. Without
  // this tag the resulting context.user.env is empty and every template
  // silently resolves to undefined.
  const templateContext = buildMCPTemplateContextFromEnv({
    ...userEnv,
    [AGOR_USER_ENV_KEYS_VAR]: Object.keys(userEnv).join(','),
  });

  const now = new Date();
  const probeServer: MCPServer = {
    mcp_server_id: ((serverConfig.mcpServerId as string | undefined) ??
      'inline-test') as MCPServerID,
    name: serverConfig.name || 'inline-test',
    transport: serverConfig.transport,
    url: serverConfig.url,
    auth: serverConfig.auth,
    scope: 'global',
    source: 'user',
    enabled: true,
    created_at: now,
    updated_at: now,
  };

  const result = resolveMcpServerTemplates(probeServer, templateContext);

  if (!result.isValid) {
    return { ok: false, error: result.errorMessage ?? 'Template resolution failed' };
  }

  // Surface unresolved auth templates as a clear error — otherwise the
  // probe sends an empty/literal Authorization header and the upstream
  // 401 hides the real cause from the user.
  //
  // The core resolver intentionally omits OAuth fields from
  // `unresolvedFields` (template-resolver.ts treats them as optional at
  // session runtime, where missing values just skip OAuth behavior). For
  // Test Connection a templated `oauth_client_secret` that resolves to
  // empty still means the OAuth flow is about to fail upstream with a
  // confusing error, so detect those locally and add them to the list.
  const unresolvedAuth = [...result.unresolvedFields.filter((f) => f.startsWith('auth.'))];
  if (serverConfig.auth?.type === 'oauth') {
    const oauthTemplatedFields = [
      'oauth_token_url',
      'oauth_client_id',
      'oauth_client_secret',
      'oauth_scope',
    ] as const;
    for (const field of oauthTemplatedFields) {
      const original = serverConfig.auth[field];
      if (original && original.includes('{{') && !result.server.auth?.[field]) {
        unresolvedAuth.push(`auth.${field}`);
      }
    }
  }

  if (unresolvedAuth.length > 0) {
    return {
      ok: false,
      error: `Unresolved env var template(s): ${unresolvedAuth.join(', ')}. Define the matching variables in Settings → Environment Variables.`,
    };
  }

  return {
    ok: true,
    resolved: {
      ...serverConfig,
      auth: result.server.auth,
      url: result.server.url ?? serverConfig.url,
    },
  };
}
