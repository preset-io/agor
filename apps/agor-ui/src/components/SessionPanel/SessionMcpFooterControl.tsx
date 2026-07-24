import type { AgorClient, MCPServer } from '@agor-live/client';
import { ApiOutlined } from '@ant-design/icons';
import { Tag as AntTag, Popover, Space, Typography, theme } from 'antd';
import React from 'react';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { useThemedMessage } from '../../utils/message';
import { updateSessionMcpServers } from '../../utils/sessionMcpServers';
import { MCPServerPill } from '../MCPServer';
import { summarizeSessionMcpServers } from '../MCPServer/mcp-session-summary';
import { MCPServerSelect } from '../MCPServerSelect';
import { Tag } from '../Tag';

export interface SessionMcpFooterControlProps {
  client: AgorClient | null;
  sessionId: string;
  sessionMcpServerIds: string[];
  mcpServerById: Map<string, MCPServer>;
  userAuthenticatedMcpServerIds: Set<string>;
}

export const SessionMcpFooterControl: React.FC<SessionMcpFooterControlProps> = ({
  client,
  sessionId,
  sessionMcpServerIds,
  mcpServerById,
  userAuthenticatedMcpServerIds,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const [saving, setSaving] = React.useState(false);

  const summary = React.useMemo(
    () =>
      summarizeSessionMcpServers(sessionMcpServerIds, mcpServerById, userAuthenticatedMcpServerIds),
    [sessionMcpServerIds, mcpServerById, userAuthenticatedMcpServerIds]
  );

  const attachedServers = React.useMemo(
    () =>
      sessionMcpServerIds
        .map((id) => mcpServerById.get(id))
        .filter((server): server is MCPServer => Boolean(server)),
    [sessionMcpServerIds, mcpServerById]
  );

  const handleChange = async (nextIds: string[]) => {
    if (!client) return;
    setSaving(true);
    try {
      await updateSessionMcpServers(client, sessionId, sessionMcpServerIds, nextIds);
      showSuccess('Session MCP servers updated');
    } catch (err) {
      showError(
        `Failed to update MCP servers: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div style={{ width: 340, maxWidth: 'min(340px, 80vw)' }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>Session MCP servers</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ margin: `${token.sizeUnit}px 0 0` }}>
            Attach tools/connectors that the agent can use in this conversation.
          </Typography.Paragraph>
        </div>

        {attachedServers.length > 0 && (
          <Space size={6} wrap>
            {attachedServers.map((server) => (
              <MCPServerPill
                key={server.mcp_server_id}
                server={server}
                needsAuth={mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)}
                client={client}
              />
            ))}
          </Space>
        )}

        <MCPServerSelect
          mcpServers={Array.from(mcpServerById.values())}
          placeholder="Attach MCP servers…"
          value={sessionMcpServerIds}
          onChange={handleChange}
          loading={saving}
          disabled={!client || saving}
          style={{ width: '100%' }}
        />
      </Space>
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement="top"
      getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
      title={null}
      content={content}
    >
      <Tag
        icon={<ApiOutlined />}
        color="default"
        title={`${summary.tooltip}. Click to add or change MCP servers.`}
        style={{ cursor: 'pointer', height: 22, display: 'inline-flex', alignItems: 'center' }}
      >
        <span>MCP</span>
        <AntTag
          color={
            summary.tone === 'error' ? 'error' : summary.tone === 'warning' ? 'warning' : undefined
          }
          style={{
            marginInlineStart: token.sizeUnit,
            marginInlineEnd: 0,
            minWidth: 16,
            height: 14,
            paddingInline: 4,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: '12px',
            fontSize: 10,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
            verticalAlign: 'middle',
          }}
        >
          {summary.attachedCount}
        </AntTag>
      </Tag>
    </Popover>
  );
};
