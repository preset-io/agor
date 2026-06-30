import type {
  AgorClient,
  GatewayChannel,
  UserAvatarSettings,
  UserAvatarSyncResult,
} from '@agor-live/client';
import { Alert, Button, Card, Checkbox, Flex, Select, Space, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '../../utils/message';

interface UserAvatarsTabProps {
  client: AgorClient | null;
  gatewayChannelById: Map<string, GatewayChannel>;
}

type UsersAvatarClient = {
  getAvatarSettings(data?: unknown): Promise<UserAvatarSettings>;
  updateAvatarSettings(data: Partial<UserAvatarSettings>): Promise<UserAvatarSettings>;
  syncAvatars(data: {
    gateway_channel_id?: string | null;
    user_id?: string;
  }): Promise<UserAvatarSyncResult>;
};

function usersAvatarClient(client: AgorClient): UsersAvatarClient {
  return client.service('users') as unknown as UsersAvatarClient;
}

const DEFAULT_SETTINGS: UserAvatarSettings = {
  enabled: false,
  provider: null,
  gateway_channel_id: null,
};

export const UserAvatarsTab: React.FC<UserAvatarsTabProps> = ({ client, gatewayChannelById }) => {
  const { showSuccess, showError } = useThemedMessage();
  const [settings, setSettings] = useState<UserAvatarSettings>(DEFAULT_SETTINGS);
  const [enabled, setEnabled] = useState(false);
  const [gatewayId, setGatewayId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<UserAvatarSyncResult | null>(null);

  const slackGateways = useMemo(
    () =>
      mapToSortedArray(gatewayChannelById, (a, b) => a.name.localeCompare(b.name)).filter(
        (channel) => channel.channel_type === 'slack'
      ),
    [gatewayChannelById]
  );

  useEffect(() => {
    if (!client) return;
    setLoading(true);
    usersAvatarClient(client)
      .getAvatarSettings({})
      .then((value) => {
        const next = value as unknown as UserAvatarSettings;
        setSettings(next);
        setEnabled(next.enabled);
        setGatewayId(next.gateway_channel_id);
        setLastResult(next.last_sync_result ?? null);
      })
      .catch((error) => showError(`Failed to load avatar settings: ${error.message}`))
      .finally(() => setLoading(false));
  }, [client, showError]);

  const save = async (nextEnabled = enabled, nextGatewayId = gatewayId) => {
    if (!client) return;
    const saved = (await usersAvatarClient(client).updateAvatarSettings({
      enabled: nextEnabled,
      provider: nextEnabled ? 'slack' : null,
      gateway_channel_id: nextEnabled ? nextGatewayId : null,
    } as Partial<UserAvatarSettings>)) as UserAvatarSettings;
    setSettings(saved);
    setEnabled(saved.enabled);
    setGatewayId(saved.gateway_channel_id);
  };

  const enableWithCurrentGateway = async (nextEnabled: boolean) => {
    const previousEnabled = enabled;
    setEnabled(nextEnabled);
    if (nextEnabled && !gatewayId) {
      return;
    }
    try {
      await save(nextEnabled, gatewayId);
    } catch (error) {
      setEnabled(previousEnabled);
      showError(
        `Failed to update avatar settings: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const selectGateway = async (nextGatewayId: string) => {
    const previousGatewayId = gatewayId;
    setGatewayId(nextGatewayId);
    if (!enabled) {
      return;
    }
    try {
      await save(true, nextGatewayId);
    } catch (error) {
      setGatewayId(previousGatewayId);
      showError(
        `Failed to update avatar settings: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const runSync = async () => {
    if (!client || !gatewayId) return;
    setSyncing(true);
    try {
      await save(true, gatewayId);
      const result = (await usersAvatarClient(client).syncAvatars({
        gateway_channel_id: gatewayId,
      })) as UserAvatarSyncResult;
      setLastResult(result);
      showSuccess(
        `Synced Slack avatars: ${result.updated} updated, ${result.skipped} skipped, ` +
          `${result.failed} failed`
      );
    } catch (error) {
      showError(
        `Slack avatar sync failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          User Slack avatars
        </Typography.Title>
        <Typography.Text type="secondary">
          Use a Slack gateway bot token to sync Slack profile image URLs onto Agor users by email.
          Agor prefers avatar_url when present and falls back to each user’s emoji tile.
        </Typography.Text>
      </div>

      <Card loading={loading} size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Checkbox
            checked={enabled}
            onChange={(event) => enableWithCurrentGateway(event.target.checked)}
          >
            Enable Slack-synced avatars
          </Checkbox>

          <Typography.Text type="secondary">
            Disabling this stops Slack avatar refreshes and removes only Slack-synced avatar URLs.
            Manually/provider-set avatar URLs are preserved.
          </Typography.Text>

          <Flex gap={12} align="center" wrap="wrap">
            <Select
              style={{ minWidth: 320 }}
              placeholder="Select Slack gateway"
              value={gatewayId ?? undefined}
              onChange={selectGateway}
              options={slackGateways.map((channel) => ({
                value: channel.id,
                label: `${channel.name}${channel.enabled ? '' : ' (disabled)'}`,
              }))}
            />
            <Button
              type="primary"
              disabled={!enabled || !gatewayId}
              loading={syncing}
              onClick={runSync}
            >
              Sync now
            </Button>
          </Flex>

          {lastResult && (
            <Typography.Text type={lastResult.failed ? 'warning' : 'secondary'}>
              Last sync: {lastResult.updated} updated, {lastResult.skipped} skipped,{' '}
              {lastResult.failed} failed at {new Date(lastResult.finished_at).toLocaleString()}.
            </Typography.Text>
          )}

          {lastResult?.failures?.length ? (
            <Alert
              type="warning"
              showIcon
              message="Avatar sync failures"
              description={
                <Space direction="vertical" size={4}>
                  {lastResult.failures.slice(0, 5).map((failure) => (
                    <Typography.Text key={`${failure.user_id}-${failure.reason}`} type="secondary">
                      {failure.email || failure.user_id}: {failure.reason}
                    </Typography.Text>
                  ))}
                  {lastResult.failures.length > 5 && (
                    <Typography.Text type="secondary">
                      …and {lastResult.failures.length - 5} more.
                    </Typography.Text>
                  )}
                </Space>
              }
            />
          ) : null}

          {settings.last_sync_at && !lastResult && (
            <Typography.Text type="secondary">
              Last sync: {new Date(settings.last_sync_at).toLocaleString()}.
            </Typography.Text>
          )}
        </Space>
      </Card>
    </Space>
  );
};
