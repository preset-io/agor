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

  const unauthedServers = React.useMemo(
    () =>
      attachedServers.filter((server) => mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)),
    [attachedServers, userAuthenticatedMcpServerIds]
  );

  const badgeTitle =
    unauthedServers.length === 1
      ? `${unauthedServers[0].display_name || unauthedServers[0].name} isn’t connected. Open to connect.`
      : unauthedServers.length > 1
        ? `${unauthedServers.length} MCP servers aren’t connected. Open to connect.`
        : `${summary.tooltip}. Click to add or change MCP servers.`;

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
        title={badgeTitle}
        style={{ cursor: 'pointer', height: 22, display: 'inline-flex', alignItems: 'center' }}
        // antd nests children in a content span, so the root's align-items never reaches the chip.
        styles={{ content: { display: 'inline-flex', alignItems: 'center' } }}
      >
        <span>MCP</span>
        <AntTag
          style={{
            marginInlineStart: token.sizeUnit,
            marginInlineEnd: 0,
            // Round notification counter: a 16px circle at one digit
            // (minWidth === height), growing into a pill for 2+ digits. The
            // large radius fully rounds the ends (clamped to height/2) in both.
            boxSizing: 'border-box',
            minWidth: 16,
            height: 16,
            paddingInline: 4,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            fontSize: 10,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
            // Recolor the count amber via semantic tokens only — the neutral chip's
            // geometry (size, radius, shape) is untouched, so the not-connected
            // state differs from the healthy state purely in color, theme-aware
            // in light and dark. Avoids AntD's `color="warning"` preset, whose own
            // fill/border/radius would shift the box vs. the neutral chip.
            ...(summary.tone === 'warning'
              ? { backgroundColor: token.colorWarningBg, color: token.colorWarning }
              : {}),
          }}
        >
          {summary.attachedCount}
        </AntTag>
      </Tag>
    </Popover>
  );
};
