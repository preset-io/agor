import type { AgorClient, MCPServer } from '@agor-live/client';
import { Alert, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { sanitizeSecretValue } from '@/utils/sanitizeSecret';

const { Text } = Typography;

export interface ConfiguredAppCredentialsModalProps {
  /** The full saved row (`mcp-servers` get): client ID readable, secret redacted. */
  server: MCPServer | null;
  /** The catalog recipe's `configured_client.secret_required`. */
  secretRequired: boolean;
  client: AgorClient | null;
  onClose: (saved: boolean) => void;
}

/**
 * Replace a customer-owned app install's Client ID and/or Client secret in
 * place, through the ordinary `mcp-servers` patch (same authorizer, sealing,
 * and redaction as Settings). The secret is write-only: the form only says
 * one is saved. A secret belongs to its Client ID, so an ID change always
 * replaces it: a new secret is required when the recipe requires one, and
 * otherwise the saved secret is cleared unless a new one is entered.
 */
export const ConfiguredAppCredentialsModal: React.FC<ConfiguredAppCredentialsModalProps> = ({
  server,
  secretRequired,
  client,
  onClose,
}) => {
  const savedClientId = server?.auth?.oauth_client_id ?? '';
  const secretSaved = Boolean(server?.auth?.oauth_client_secret);
  const [clientId, setClientId] = useState(savedClientId);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per opened server
  useEffect(() => {
    setClientId(savedClientId);
    setSecret('');
    setError(null);
  }, [server?.mcp_server_id]);

  const trimmedId = clientId.trim();
  const newSecret = sanitizeSecretValue(secret);
  const idChanged = trimmedId !== savedClientId;
  const secretMissing = secretRequired && !newSecret && (idChanged || !secretSaved);
  const canSave = Boolean(server && trimmedId && (idChanged || newSecret) && !secretMissing);

  const save = async () => {
    if (!server || !client || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await client.service('mcp-servers').patch(server.mcp_server_id, {
        auth: {
          type: 'oauth',
          oauth_client_id: trimmedId,
          // A secret never carries over to a different Client ID; `null`
          // clears the saved one through the ordinary auth patch.
          ...(newSecret
            ? { oauth_client_secret: newSecret }
            : idChanged && secretSaved
              ? { oauth_client_secret: null }
              : {}),
        },
        ...(server.config_version !== undefined
          ? { expected_config_version: server.config_version }
          : {}),
      });
      setSecret('');
      onClose(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the OAuth app');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={server !== null}
      title="Edit OAuth app credentials"
      okText="Save credentials"
      okButtonProps={{ disabled: !canSave, loading: saving }}
      onOk={() => void save()}
      onCancel={() => {
        setSecret('');
        onClose(false);
      }}
      destroyOnHidden
    >
      <Form layout="vertical">
        <Alert
          type="warning"
          showIcon
          title="Saving replaces the app credentials. Everyone using this installation must reconnect."
          style={{ marginBottom: 16 }}
        />
        <Form.Item label="OAuth app Client ID" required>
          <Input
            aria-label="OAuth app Client ID"
            value={clientId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setClientId(event.target.value)}
          />
        </Form.Item>
        <Form.Item
          label="OAuth app Client secret"
          required={secretRequired && (idChanged || !secretSaved)}
          extra={
            <Text type="secondary">
              {secretSaved
                ? idChanged
                  ? secretRequired
                    ? 'A new Client ID needs its own Client secret.'
                    : 'Changing the Client ID clears the saved secret unless you enter a new one.'
                  : 'A secret is saved and never shown. Leave blank to keep it.'
                : 'No secret is saved.'}
            </Text>
          }
        >
          <Input.Password
            aria-label="OAuth app Client secret"
            value={secret}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={secretSaved ? 'Saved secret (hidden)' : undefined}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Form.Item>
        {error && <Alert type="error" showIcon title={error} />}
      </Form>
    </Modal>
  );
};
