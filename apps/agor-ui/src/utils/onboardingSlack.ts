import type {
  AgorClient,
  EffectiveCapabilityPolicyAccess,
  GatewayChannel,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';

/** Transient setup request, not a grant or a credential. */
export type OnboardingSlackGatewayIntent = 'prefer-existing' | 'request-new';

/** Read only redacted inventory and the daemon's effective branch authority. */
export async function readOnboardingSlackGateways(client: AgorClient) {
  const channels = await client.service('gateway-channels').findAll({
    query: { channel_type: 'slack', enabled: true },
  });
  const existing: Pick<GatewayChannel, 'id' | 'name' | 'target_branch_id'>[] = [];
  for (const channel of channels) {
    if (channel.channel_type !== 'slack' || !channel.enabled) continue;
    try {
      const access = (await client.service('branches/:id/effective-access').find({
        route: { id: channel.target_branch_id },
      })) as unknown as EffectiveCapabilityPolicyAccess;
      if (access.capabilities.includes('sessions.create')) {
        existing.push({
          id: channel.id,
          name: channel.name,
          target_branch_id: channel.target_branch_id,
        });
      }
    } catch {
      // Unknown permission is not evidence that no usable gateway exists.
      throw new Error(
        'Could not verify existing Slack gateway access. Retry before requesting a new gateway.'
      );
    }
  }
  return existing;
}

/** Recheck inventory and authority at completion, not just when a checkbox was shown. */
export async function resolveOnboardingSlackIntent(
  client: AgorClient,
  user: User,
  requested: OnboardingSlackGatewayIntent | undefined
): Promise<OnboardingSlackGatewayIntent | undefined> {
  if (!requested) return undefined;
  if (requested !== 'request-new' || !hasMinimumRole(user.role, ROLES.ADMIN))
    return 'prefer-existing';
  try {
    const freshUser = await client.service('users').get(user.user_id);
    if (!hasMinimumRole(freshUser.role, ROLES.ADMIN)) return 'prefer-existing';
    return (await readOnboardingSlackGateways(client)).length ? 'prefer-existing' : 'request-new';
  } catch {
    return 'prefer-existing';
  }
}
