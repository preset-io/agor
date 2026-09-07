import { requirePublicBaseUrl } from '@agor/core/config';
import { assertSafeOAuthUrl } from '@agor/core/utils/safe-outbound-fetch';

export const MCP_OAUTH_CALLBACK_PATH = '/mcp-servers/oauth-callback';

export interface ResolveMCPOAuthRedirectUriOptions {
  daemonPort: number;
  /** Remote browsers need a shared HTTPS callback; local developer tools use loopback. */
  usePublicHttps: boolean;
  resolvePublicBaseUrl?: () => Promise<string>;
}

/**
 * Resolve the browser callback without performing a DNS lookup.
 *
 * Standalone Agor follows the native-app OAuth pattern used by local developer
 * tools: the user's browser redirects directly to this daemon over loopback.
 * A remotely accessed daemon can explicitly opt into its configured public
 * HTTPS URL. Callback selection is independent of the database dialect.
 */
export async function resolveMCPOAuthRedirectUri({
  daemonPort,
  usePublicHttps,
  resolvePublicBaseUrl = requirePublicBaseUrl,
}: ResolveMCPOAuthRedirectUriOptions): Promise<string> {
  if (!usePublicHttps) {
    const redirectUri = `http://127.0.0.1:${daemonPort}${MCP_OAUTH_CALLBACK_PATH}`;
    assertSafeOAuthUrl(redirectUri, { allowLocalhostHttp: true });
    return redirectUri;
  }

  const baseUrl = await resolvePublicBaseUrl();
  const redirectUri = new URL(MCP_OAUTH_CALLBACK_PATH, baseUrl).toString();
  assertSafeOAuthUrl(redirectUri);
  return redirectUri;
}
