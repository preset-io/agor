/**
 * Recommended Teams app manifest material. This is a setup artifact, not a
 * live-provider verification result. RSC catch-up remains best-effort and is
 * never required for the current mention path.
 */

export const TEAMS_RSC_APPLICATION_PERMISSIONS = ['ChannelMessage.Read.Group'] as const;
export const TEAMS_BOT_SCOPES = ['personal', 'team', 'groupchat'] as const;

export interface TeamsSetupManifestOptions {
  appId: string;
  gatewayChannelId: string;
  displayName?: string;
  callbackOrigin?: string;
}

export function teamsGatewayCallbackUrl(options: TeamsSetupManifestOptions): string {
  const rawOrigin = options.callbackOrigin || 'https://your-agor-host.example';
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error('Teams callback origin must be a valid HTTPS origin');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Teams callback origin must be a valid HTTPS origin');
  }
  return `${origin.origin}/gateway/teams/${encodeURIComponent(options.gatewayChannelId)}/activities`;
}

/** Return the smallest manifest that exposes the supported bot surfaces and RSC. */
export function buildTeamsSetupManifest(
  options: TeamsSetupManifestOptions
): Record<string, unknown> {
  const name = options.displayName?.trim() || 'Agor Teams gateway';
  let validDomain: string | undefined;
  try {
    validDomain = new URL(teamsGatewayCallbackUrl(options)).hostname;
  } catch {
    // The placeholder remains visible in the callback URL; omit validDomains
    // rather than presenting a malformed domain as a verified setup result.
  }
  return {
    $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: '1.0.0',
    id: options.appId,
    packageName: `live.agor.teams.${options.appId.toLowerCase()}`,
    developer: {
      name: 'Agor',
      websiteUrl: 'https://agor.live',
      privacyUrl: 'https://agor.live/privacy',
      termsOfUseUrl: 'https://agor.live/terms',
    },
    name: { short: name.slice(0, 30), full: name.slice(0, 100) },
    description: {
      short: 'Route Teams conversations to Agor.',
      full: 'Routes authenticated Teams conversations to an Agor gateway channel.',
    },
    icons: { outline: 'outline.png', color: 'color.png' },
    accentColor: '#5B5FC7',
    bots: [
      {
        botId: options.appId,
        scopes: [...TEAMS_BOT_SCOPES],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    ...(validDomain ? { validDomains: [validDomain] } : {}),
    authorization: {
      permissions: {
        resourceSpecific: TEAMS_RSC_APPLICATION_PERMISSIONS.map((name) => ({
          name,
          type: 'Application',
        })),
      },
    },
    webApplicationInfo: { id: options.appId, resource: 'https://api.botframework.com' },
  };
}
