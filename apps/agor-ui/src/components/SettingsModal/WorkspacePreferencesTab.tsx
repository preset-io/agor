import type { AgorClient, CapabilityPolicyWorkspacePreferences, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Alert, App, Button, Card, Flex, Skeleton, Switch, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';

const DEFAULT_PREFERENCES: CapabilityPolicyWorkspacePreferences = {
  session_sharing_enabled: false,
};

export interface WorkspacePreferencesTabProps {
  client: AgorClient | null;
  currentUser?: User | null;
}

export const WorkspacePreferencesTab: React.FC<WorkspacePreferencesTabProps> = ({
  client,
  currentUser,
}) => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const [value, setValue] = useState(DEFAULT_PREFERENCES);
  const [saved, setSaved] = useState(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (!client) {
      setLoading(false);
      setError('Workspace preferences are unavailable while disconnected.');
      return;
    }
    client
      .service('workspace-preferences')
      .find()
      .then((preferences) => {
        if (cancelled) return;
        setValue(preferences);
        setSaved(preferences);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : 'Could not load workspace preferences.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const dirty = value.session_sharing_enabled !== saved.session_sharing_enabled;

  const save = async () => {
    if (!client || !isAdmin) return;
    setSaving(true);
    try {
      const next = await client.service('workspace-preferences').patch(null, value);
      setValue(next);
      setSaved(next);
      message.success('Workspace preferences saved');
    } catch (reason) {
      message.error(
        reason instanceof Error ? reason.message : 'Could not save workspace preferences'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex vertical gap={token.paddingLG} style={{ maxWidth: 720 }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0, marginBottom: token.marginXXS }}>
          Workspace Preferences
        </Typography.Title>
        <Typography.Text type="secondary">Workspace-wide product settings.</Typography.Text>
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : error ? (
        <Alert type="error" showIcon description={error} />
      ) : (
        <Card size="small">
          <Flex justify="space-between" align="flex-start" gap={token.paddingLG} wrap>
            <Flex vertical gap={token.paddingXXS} style={{ flex: 1, minWidth: 240 }}>
              <Typography.Text strong>Session sharing</Typography.Text>
              <Typography.Text type="secondary">
                Let Board and Branch Managers allow collaborators to continue one another’s
                branch-home sessions. Off disables and clears every board and branch opt-in.
              </Typography.Text>
            </Flex>
            <Switch
              checked={value.session_sharing_enabled}
              disabled={!isAdmin}
              aria-label="Allow session sharing in this workspace"
              onChange={(session_sharing_enabled) => setValue({ session_sharing_enabled })}
            />
          </Flex>
          {!isAdmin && (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', marginTop: token.marginSM }}
            >
              Only workspace admins can change this setting.
            </Typography.Text>
          )}
        </Card>
      )}

      {isAdmin && !loading && !error && (
        <Flex justify="flex-end">
          <Button type="primary" disabled={!dirty} loading={saving} onClick={save}>
            Save
          </Button>
        </Flex>
      )}
    </Flex>
  );
};
