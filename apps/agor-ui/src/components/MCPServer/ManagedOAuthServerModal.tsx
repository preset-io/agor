import { Alert, Button, Descriptions, Flex, Modal, Typography, theme } from 'antd';
import { useThemedMessage } from '@/utils/message';
import type { MCPServerEditModalProps } from './MCPServerEditModal';
import { useMCPServerOAuthStart } from './useMCPServerOAuthStart';

/**
 * Managed identity is not an editable BYO form. In particular, opening Settings
 * must not round-trip absent managed client fields through the direct form's
 * client_credentials/DCR defaults or turn another owner's row into this mode.
 */
export function ManagedOAuthServerModal(props: MCPServerEditModalProps) {
  const { server, client, authorityKey, mutationAllowed, open, onClose, afterClose } = props;
  const { token } = theme.useToken();
  const { showError, showInfo, showSuccess } = useThemedMessage();
  const supported =
    server?.auth?.type === 'oauth' &&
    server.auth.oauth_mode === 'per_user' &&
    server.auth.oauth_client_mode === 'cloud_managed_v1' &&
    Boolean(server.auth.oauth_managed_profile);
  const oauth = useMCPServerOAuthStart({
    client,
    authorityKey,
    onPrepareOAuthStart: async () => (supported ? (server?.mcp_server_id ?? null) : null),
    startAllowed: open && supported && mutationAllowed,
    startBlockedReason: props.mutationBlockedReason,
    showError,
    showInfo,
    showSuccess,
    managed: supported,
  });
  const profile = server?.auth?.oauth_managed_profile;
  return (
    <Modal
      title="Agor-managed connection"
      open={open}
      onCancel={() => {
        oauth.cancelOAuthWait();
        onClose();
      }}
      afterClose={afterClose}
      destroyOnHidden
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Flex vertical gap={token.marginSM}>
        <Alert
          type={supported ? 'info' : 'warning'}
          showIcon
          title={supported ? 'Agor-managed sign-in' : 'Unsupported OAuth client mode'}
          description="This connection cannot be converted or edited as a personal OAuth app. Use Catalog to create a separate connection; existing session attachments stay unchanged."
        />
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: 'name', label: 'Server', children: server?.display_name ?? server?.name },
            {
              key: 'owner',
              label: 'Account',
              children: 'Per-user; each teammate connects separately',
            },
            {
              key: 'profile',
              label: 'Profile',
              children: profile
                ? `${profile.profile_id} (${profile.semantic_version})`
                : 'Unavailable',
            },
            { key: 'region', label: 'Region', children: profile?.region ?? 'Unavailable' },
          ]}
        />
        {oauth.oauthFailure && (
          <Alert
            type="error"
            showIcon
            title="Sign-in unavailable"
            description={oauth.oauthFailure.message}
          />
        )}
        {oauth.oauthCallbackModalVisible && (
          <Typography.Text role="status">
            Sign-in pending. Finish in the provider window; only saved local completion confirms
            this connection.
          </Typography.Text>
        )}
        <Button
          type="primary"
          disabled={!supported || !mutationAllowed || !authorityKey}
          loading={oauth.startingOAuthFlow}
          onClick={oauth.handleStartOAuthFlow}
        >
          Sign in again
        </Button>
        <Typography.Text type="secondary">
          Choose this server in each session's MCP menu after sign-in. Remove an old attachment only
          where you want to switch. Your other connections are not changed.
        </Typography.Text>
      </Flex>
    </Modal>
  );
}
