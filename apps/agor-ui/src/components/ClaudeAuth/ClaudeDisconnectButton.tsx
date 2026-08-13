import type { AgorClient } from '@agor-live/client';
import { Alert, Button, Popconfirm, Space, Typography, theme } from 'antd';
import { memo, useCallback, useState } from 'react';

const { Text } = Typography;
const { useToken } = theme;

export interface ClaudeDisconnectButtonProps {
  client: AgorClient | null;
}

/**
 * Removes the Claude subscription login from THIS server (delete-only, no token
 * revocation). The daemon deletes ~/.claude/.credentials.json and clears the
 * stored token + method; that patch flips the auth method off `subscription`, so
 * the surrounding pane re-syncs to the disconnected state on its own — there is
 * no local state to reset here. Mirrors the Codex "Remove login" control.
 */
export const ClaudeDisconnectButton = memo(function ClaudeDisconnectButton({
  client,
}: ClaudeDisconnectButtonProps) {
  const { token } = useToken();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleDisconnect = useCallback(async () => {
    if (!client) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await client.service('claude-auth/logout').create({});
    } catch (err) {
      setRemoveError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not remove the Claude login — try again.'
      );
    } finally {
      setRemoving(false);
    }
  }, [client]);

  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Popconfirm
        title="Disconnect Claude login?"
        description={
          <div style={{ maxWidth: 340 }}>
            Signs Claude out on this server only — your other devices stay signed in. In
            shared-identity setups this is one login for the whole server, so removing it
            disconnects Claude for everyone on it. To revoke this login everywhere, use your Claude
            account settings or run <Text code>/logout</Text> on a machine where you're signed in.
          </div>
        }
        okText="Disconnect"
        okButtonProps={{ danger: true, loading: removing }}
        cancelText="Keep login"
        onConfirm={handleDisconnect}
      >
        <Button type="link" size="small" danger loading={removing} disabled={!client}>
          Disconnect
        </Button>
      </Popconfirm>
      {removeError && (
        <Alert type="error" showIcon message={removeError} style={{ fontSize: token.fontSizeSM }} />
      )}
    </Space>
  );
});
