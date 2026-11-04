import type { AgorPackImport, UpdateUserInput } from '@agor/core/types';
import type { AgorClient, EnvVarScope, Schedule, User } from '@agor-live/client';
import { Alert, Button, Flex, List, Space, Switch, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useMCPCatalogModal } from '../../contexts/MCPCatalogModalContext';
import { useAuthenticatedAuthorityScope } from '../../hooks/useAuthorityOperationGuard';
import { useThemedMessage } from '../../utils/message';
import { EnvVarEditor, type EnvVarEntry } from '../EnvVarEditor';
import { Tag } from '../Tag';

export interface ReconnectChecklistProps {
  client?: AgorClient | null;
  currentUser?: User | null;
  receipt: AgorPackImport;
}

const FILESYSTEM_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: 'processing', label: 'restoring files' },
  ready: { color: 'success', label: 'files ready' },
  failed: { color: 'error', label: 'files failed' },
  skipped: { color: 'default', label: 'no files' },
};

/**
 * What still needs a human after an import: credentials that travelled by
 * name only, MCP servers to connect, gateway channels to recreate, and
 * schedules that arrived disabled. Every item reuses the normal settings
 * surfaces; nothing here stores a secret anywhere else.
 */
export const ReconnectChecklist: React.FC<ReconnectChecklistProps> = ({
  client,
  currentUser,
  receipt,
}) => {
  const { showError } = useThemedMessage();
  const catalog = useMCPCatalogModal();
  const authority = useAuthenticatedAuthorityScope(
    client ?? null,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );
  const imported = receipt.manifest.teammates.filter((t) =>
    receipt.results.some((r) => r.key === t.key)
  );
  const [userEnv, setUserEnv] = useState<Record<string, EnvVarEntry>>(
    () => (currentUser?.env_vars as Record<string, EnvVarEntry> | undefined) ?? {}
  );
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  const envRequirements = useMemo(() => {
    const byName = new Map<string, EnvVarScope>();
    for (const teammate of imported) {
      for (const env of teammate.requirements.env_vars) {
        byName.set(env.name, (env.scope ?? 'global') as EnvVarScope);
      }
    }
    return byName;
  }, [imported]);

  const envVars = useMemo(() => {
    const out: Record<string, EnvVarEntry> = {};
    for (const [name, scope] of envRequirements) {
      out[name] = userEnv[name] ?? { set: false as never, scope };
    }
    return out;
  }, [envRequirements, userEnv]);

  const scheduleIds = useMemo(
    () => receipt.results.flatMap((result) => result.remap.schedules),
    [receipt.results]
  );
  useEffect(() => {
    if (!client || scheduleIds.length === 0) return;
    let cancelled = false;
    Promise.all(scheduleIds.map((id) => client.service('schedules').get(id)))
      .then((rows) => !cancelled && setSchedules(rows as Schedule[]))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, scheduleIds]);

  const saveEnv = async (key: string, value: string, scope: EnvVarScope) => {
    if (!client || !currentUser) return;
    setSaving((prev) => ({ ...prev, [key]: true }));
    try {
      const updates: UpdateUserInput = {
        env_vars: { [key]: value },
        env_var_scopes: { [key]: scope },
      };
      // The daemon encrypts plaintext env vars; the client types patch as Partial<User>.
      await client.service('users').patch(currentUser.user_id, updates as Partial<User>);
      setUserEnv((prev) => ({ ...prev, [key]: { set: true, scope, resource_id: null } }));
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  const toggleSchedule = async (schedule: Schedule, enabled: boolean) => {
    if (!client) return;
    try {
      const updated = (await client
        .service('schedules')
        .patch(schedule.schedule_id, { enabled })) as Schedule;
      setSchedules((prev) =>
        prev.map((s) => (s.schedule_id === updated.schedule_id ? updated : s))
      );
    } catch (error) {
      showError(
        `Could not update schedule: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const mcp = imported.flatMap((t) => t.requirements.mcp_servers);
  const channels = imported.flatMap((t) => t.requirements.gateway_channels);
  const warnings = receipt.results.flatMap((r) => r.warnings.map((w) => `${r.display_name}: ${w}`));

  return (
    <Flex vertical gap="middle">
      <List
        size="small"
        bordered
        header={<Typography.Text strong>Imported</Typography.Text>}
        dataSource={receipt.results}
        renderItem={(result) => (
          <List.Item>
            <Space wrap>
              <Typography.Text>{result.display_name}</Typography.Text>
              <Tag color={FILESYSTEM_TAG[result.filesystem]?.color}>
                {FILESYSTEM_TAG[result.filesystem]?.label}
              </Tag>
              {result.filesystem_error && (
                <Typography.Text type="danger">{result.filesystem_error}</Typography.Text>
              )}
            </Space>
          </List.Item>
        )}
      />

      {envRequirements.size > 0 && (
        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Environment variables
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            These travelled by name only. Set the values here; they are stored encrypted in your
            account.
          </Typography.Paragraph>
          <EnvVarEditor
            envVars={envVars}
            onSave={saveEnv}
            onDelete={async () => undefined}
            loading={saving}
            hideDescription
            identityKey={authority.identityKey}
            operationScope={authority.operationScope}
          />
        </div>
      )}

      {mcp.length > 0 && (
        <List
          size="small"
          bordered
          header={<Typography.Text strong>MCP servers</Typography.Text>}
          dataSource={mcp}
          renderItem={(server) => (
            <List.Item
              actions={[
                <Button key="connect" size="small" onClick={() => catalog?.openCatalog()}>
                  {server.custom ? 'Review' : 'Connect'}
                </Button>,
              ]}
            >
              <Space wrap>
                <Typography.Text>{server.display_name ?? server.name}</Typography.Text>
                <Tag color={server.custom ? 'warning' : 'blue'}>
                  {server.custom ? 'added disabled' : 'catalog'}
                </Tag>
              </Space>
            </List.Item>
          )}
        />
      )}

      {channels.length > 0 && (
        <List
          size="small"
          bordered
          header={<Typography.Text strong>Gateway channels</Typography.Text>}
          dataSource={channels}
          renderItem={(channel) => (
            <List.Item>
              <Space wrap>
                <Typography.Text>{channel.name}</Typography.Text>
                <Tag>{channel.channel_type}</Tag>
                <Typography.Text type="secondary">
                  Ask an admin to connect it in Settings → Gateway Channels
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}

      {schedules.length > 0 && (
        <List
          size="small"
          bordered
          header={<Typography.Text strong>Schedules (imported paused)</Typography.Text>}
          dataSource={schedules}
          renderItem={(schedule) => (
            <List.Item
              actions={[
                <Switch
                  key="enabled"
                  checked={schedule.enabled}
                  aria-label={`Enable ${schedule.name}`}
                  onChange={(enabled) => toggleSchedule(schedule, enabled)}
                />,
              ]}
            >
              <Space wrap>
                <Typography.Text>{schedule.name}</Typography.Text>
                <Typography.Text type="secondary" code>
                  {schedule.cron_expression}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}

      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Notes from the import"
          description={
            <Flex vertical gap={2}>
              {warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </Flex>
          }
        />
      )}
    </Flex>
  );
};
