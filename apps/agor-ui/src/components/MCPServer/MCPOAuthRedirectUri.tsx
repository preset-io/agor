import type { MCPOAuthStatusResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { Form, Typography } from 'antd';
import { useEffect, useState } from 'react';

/**
 * The callback a custom server's OAuth flow registers for this workspace, as
 * resolved by the daemon (the browser's origin may not be the callback host).
 * Renders nothing until, or unless, the daemon returns one.
 */
export function MCPOAuthRedirectUri({ client }: { client: AgorClient | null }) {
  const [redirectUri, setRedirectUri] = useState<string>();

  useEffect(() => {
    setRedirectUri(undefined);
    if (!client) return;
    let current = true;
    // Any failure, sync or async, shows nothing rather than a guessed URL.
    Promise.resolve()
      .then(() => client.service('mcp-servers/oauth-status').find())
      .then((status) => {
        if (current) setRedirectUri((status as Partial<MCPOAuthStatusResult>)?.redirect_uri);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [client]);

  if (!redirectUri) return null;
  return (
    <Form.Item label="Callback URL" extra="Add this redirect URL to your OAuth app.">
      <Typography.Text code copyable>
        {redirectUri}
      </Typography.Text>
    </Form.Item>
  );
}
