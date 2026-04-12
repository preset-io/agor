import type { AgorClient, MCPServer } from '@agor-live/client';
import { ApiOutlined, LoginOutlined } from '@ant-design/icons';
import { App, Tooltip } from 'antd';
import { Tag } from './Tag';

interface MCPServerPillProps {
  server: MCPServer;
  needsAuth: boolean;
  client: AgorClient | null;
}

/**
 * Clickable MCP server pill. Shows orange with login icon when auth is needed,
 * purple with API icon otherwise. Clicking an unauthenticated pill starts the
 * OAuth flow and opens the provider in a new tab.
 */
export const MCPServerPill: React.FC<MCPServerPillProps> = ({ server, needsAuth, client }) => {
  const { message } = App.useApp();

  const handleOAuthClick = async () => {
    if (!client) return;
    try {
      const data = (await client.service('mcp-servers/oauth-start').create({
        mcp_url: server.url,
        mcp_server_id: server.mcp_server_id,
        client_id: server.auth?.oauth_client_id,
      })) as {
        success: boolean;
        error?: string;
        authorizationUrl?: string;
        state?: string;
      };

      if (data.success && data.authorizationUrl) {
        window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
        message.info('Complete sign-in in the new tab.');

        // Listen for completion — show toast when done
        if (data.state) {
          const handleCompleted = (event: { state: string; success: boolean }) => {
            if (event.state === data.state && event.success) {
              message.success(`${server.display_name || server.name} authenticated!`);
              client.io.off('oauth:completed', handleCompleted);
            }
          };
          client.io.on('oauth:completed', handleCompleted);
          // Clean up after 5 minutes (flow timeout)
          setTimeout(() => client.io.off('oauth:completed', handleCompleted), 5 * 60 * 1000);
        }
      } else if (!data.success) {
        message.error(data.error || 'Failed to start OAuth flow');
      }
    } catch (err) {
      message.error(`OAuth error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Tooltip title={needsAuth ? 'Click to authenticate' : undefined}>
      <Tag
        color={needsAuth ? 'orange' : 'purple'}
        icon={needsAuth ? <LoginOutlined /> : <ApiOutlined />}
        style={needsAuth ? { cursor: 'pointer' } : undefined}
        onClick={needsAuth ? handleOAuthClick : undefined}
      >
        {server.display_name || server.name}
      </Tag>
    </Tooltip>
  );
};
