import {
  AppVariableRepository,
  GatewayChannelRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, Forbidden } from '@agor/core/feathers';
import { SlackConnector } from '@agor/core/gateway';
import type {
  AuthenticatedParams,
  GatewayChannel,
  Params,
  User,
  UserAvatarSettings,
  UserAvatarSyncRequest,
  UserAvatarSyncResult,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

const NAMESPACE = 'user_avatars';
const SETTINGS_KEY = 'settings';

const DEFAULT_SETTINGS: UserAvatarSettings = {
  enabled: false,
  provider: null,
  gateway_channel_id: null,
};

function isAdmin(params?: Params): boolean {
  return hasMinimumRole((params as AuthenticatedParams | undefined)?.user?.role, ROLES.ADMIN);
}

function requireAdmin(params?: Params): void {
  if (params?.provider && !isAdmin(params)) {
    throw new Forbidden('Only admins can manage user avatars');
  }
}

function parseSettings(raw: string | null): UserAvatarSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<UserAvatarSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function isUsableAvatarUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export class UserAvatarSyncManager {
  private variables: AppVariableRepository;
  private gatewayChannels: GatewayChannelRepository;
  private users: UsersRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private app: Application
  ) {
    this.variables = new AppVariableRepository(db);
    this.gatewayChannels = new GatewayChannelRepository(db);
    this.users = new UsersRepository(db);
  }

  async getSettings(params?: Params): Promise<UserAvatarSettings> {
    requireAdmin(params);
    const raw = await this.variables.getPlain(NAMESPACE, SETTINGS_KEY);
    return parseSettings(raw);
  }

  async updateSettings(data: Partial<UserAvatarSettings>, params?: Params) {
    requireAdmin(params);
    const current = await this.getSettings();
    const next: UserAvatarSettings = {
      ...current,
      ...data,
      provider: data.enabled === false ? null : (data.provider ?? current.provider ?? 'slack'),
      gateway_channel_id:
        data.enabled === false ? null : (data.gateway_channel_id ?? current.gateway_channel_id),
    };
    if (next.enabled && !next.gateway_channel_id) {
      throw new Error('Select a Slack gateway channel before enabling Slack avatars');
    }
    await this.saveSettings(
      next,
      (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined
    );
    if (data.enabled === false) {
      await this.clearSlackAvatars();
    }
    return next;
  }

  async syncAvatars(
    data: UserAvatarSyncRequest = {},
    params?: Params
  ): Promise<UserAvatarSyncResult> {
    requireAdmin(params);
    const settings = await this.getSettings();
    const gatewayChannelId = data.gateway_channel_id ?? settings.gateway_channel_id;
    const result = data.user_id
      ? await this.refreshSingleUser(data.user_id as UserID, gatewayChannelId, {
          mode: 'single',
        })
      : await this.refreshAllUsers(gatewayChannelId);

    const nextSettings: UserAvatarSettings = {
      ...settings,
      enabled: true,
      provider: 'slack',
      gateway_channel_id: gatewayChannelId ?? settings.gateway_channel_id,
      last_sync_at: result.finished_at,
      last_sync_result: result,
    };
    await this.saveSettings(
      nextSettings,
      (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined
    );
    return result;
  }

  async refreshUserFromSettings(userId: UserID): Promise<UserAvatarSyncResult | null> {
    const settings = await this.getSettings();
    if (!settings.enabled || settings.provider !== 'slack' || !settings.gateway_channel_id) {
      return null;
    }
    return this.refreshSingleUser(userId, settings.gateway_channel_id, {
      mode: 'single',
    });
  }

  private async saveSettings(settings: UserAvatarSettings, updatedBy?: UserID): Promise<void> {
    await this.variables.set({
      namespace: NAMESPACE,
      key: SETTINGS_KEY,
      value: JSON.stringify(settings),
      content_type: 'application/json',
      updated_by: updatedBy ?? null,
    });
  }

  private async clearSlackAvatars(): Promise<void> {
    const allUsers = await this.users.findAll();
    const slackUsers = allUsers.filter((user) => user.avatar_source === 'slack');
    await Promise.all(
      slackUsers.map((user) =>
        this.app.service('users').patch(
          user.user_id,
          {
            avatar_url: null,
            avatar: null,
            avatar_source: null,
            avatar_source_id: null,
            avatar_synced_at: null,
          } as unknown as Partial<User>,
          {
            skipAvatarRefresh: true,
            user: {
              user_id: 'user-avatars-service',
              email: 'user-avatars@agor.internal',
              role: ROLES.ADMIN,
              _isServiceAccount: true,
            },
          } as Params
        )
      )
    );
  }

  private async getSlackGateway(
    gatewayChannelId: string | null | undefined
  ): Promise<GatewayChannel> {
    if (!gatewayChannelId) throw new Error('Select a Slack gateway channel first');
    const channel = await this.gatewayChannels.findById(gatewayChannelId);
    if (!channel) throw new Error(`Gateway channel not found: ${gatewayChannelId}`);
    if (channel.channel_type !== 'slack') throw new Error('Selected gateway channel is not Slack');
    if (!channel.config?.bot_token || typeof channel.config.bot_token !== 'string') {
      throw new Error('Selected Slack gateway is missing a bot token');
    }
    return channel;
  }

  private async refreshAllUsers(gatewayChannelId: string | null | undefined) {
    const startedAt = new Date().toISOString();
    const channel = await this.getSlackGateway(gatewayChannelId);
    const connector = new SlackConnector(channel.config);
    const allUsers = await this.users.findAll();
    let matched = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const failures: UserAvatarSyncResult['failures'] = [];

    for (const user of allUsers) {
      try {
        const one = await this.refreshUserWithConnector(user, connector);
        matched += one.matched;
        updated += one.updated;
        skipped += one.skipped;
        failed += one.failed;
        failures.push(...one.failures);
      } catch (error) {
        failed += 1;
        failures.push({
          user_id: user.user_id,
          email: user.email,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      ok: failed === 0,
      mode: 'bulk' as const,
      gateway_channel_id: channel.id,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      matched,
      updated,
      skipped,
      failed,
      failures,
    };
  }

  private async refreshSingleUser(
    userId: UserID,
    gatewayChannelId: string | null | undefined,
    options: { mode: 'single' }
  ): Promise<UserAvatarSyncResult> {
    const startedAt = new Date().toISOString();
    const channel = await this.getSlackGateway(gatewayChannelId);
    const connector = new SlackConnector(channel.config);
    const user = await this.users.findById(userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const one = await this.refreshUserWithConnector(user, connector);
    return {
      ok: one.failed === 0,
      mode: options.mode,
      gateway_channel_id: channel.id,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ...one,
    };
  }

  private async refreshUserWithConnector(
    user: User,
    connector: SlackConnector
  ): Promise<
    Pick<UserAvatarSyncResult, 'matched' | 'updated' | 'skipped' | 'failed' | 'failures'>
  > {
    if (!user.email) {
      return { matched: 0, updated: 0, skipped: 1, failed: 0, failures: [] };
    }
    if (user.preferences?.use_slack_avatar === false) {
      return { matched: 0, updated: 0, skipped: 1, failed: 0, failures: [] };
    }

    try {
      const profile = await connector.lookupUserAvatarByEmail(user.email);
      if (!profile) {
        return { matched: 0, updated: 0, skipped: 1, failed: 0, failures: [] };
      }
      if (!isUsableAvatarUrl(profile.avatarUrl)) {
        return { matched: 1, updated: 0, skipped: 1, failed: 0, failures: [] };
      }

      await this.app.service('users').patch(
        user.user_id,
        {
          avatar_url: profile.avatarUrl,
          avatar_source: 'slack',
          avatar_source_id: profile.slackUserId,
          avatar_synced_at: new Date().toISOString(),
        } as Partial<User>,
        {
          skipAvatarRefresh: true,
          // users.patch has field-level/profile ownership hooks even for
          // internal calls. Avatar sync is an admin-only service action, so
          // carry an internal service user through the hook chain rather than
          // bypassing the users service and losing Feathers events.
          user: {
            user_id: 'user-avatars-service',
            email: 'user-avatars@agor.internal',
            role: ROLES.ADMIN,
            _isServiceAccount: true,
          },
        } as Params
      );

      return { matched: 1, updated: 1, skipped: 0, failed: 0, failures: [] };
    } catch (error) {
      return {
        matched: 0,
        updated: 0,
        skipped: 0,
        failed: 1,
        failures: [
          {
            user_id: user.user_id,
            email: user.email,
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
}
