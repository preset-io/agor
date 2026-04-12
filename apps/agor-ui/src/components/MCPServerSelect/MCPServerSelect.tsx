import type { MCPServer } from '@agor-live/client';
import { Select, type SelectProps } from 'antd';

export interface MCPServerSelectProps extends Omit<SelectProps, 'options'> {
  mcpServers: MCPServer[];
  value?: string[];
  onChange?: (value: string[]) => void;
  placeholder?: string;
  filterByScope?: 'global' | 'repo' | 'session';
}

/**
 * Reusable MCP Server multi-select component
 *
 * Features:
 * - Displays enabled MCP servers with display_name or fallback to name
 * - Supports filtering by scope (global, repo, session)
 * - Multi-select mode with search
 * - Shows transport type in parentheses (stdio, http, sse)
 */
export const MCPServerSelect: React.FC<MCPServerSelectProps> = ({
  mcpServers,
  value,
  onChange,
  placeholder = 'Select MCP servers...',
  filterByScope,
  ...selectProps
}) => {
  // Filter servers by scope if specified
  const filteredServers = filterByScope
    ? mcpServers.filter((server) => server.scope === filterByScope)
    : mcpServers;

  // Only show enabled servers
  const enabledServers = filteredServers.filter((server) => server.enabled);

  const options = enabledServers
    .map((server) => {
      const name = server.display_name || server.name;
      const authSuffix =
        server.auth?.type === 'oauth'
          ? ` · OAuth ${server.auth.oauth_mode === 'shared' ? '(shared)' : '(per-user)'}`
          : server.auth?.type === 'bearer' || server.auth?.token
            ? ' · Token'
            : '';
      return {
        label: `${name} (${server.transport})${authSuffix}`,
        value: server.mcp_server_id,
        disabled: !server.enabled,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <Select
      mode="multiple"
      placeholder={placeholder}
      allowClear
      showSearch
      optionFilterProp="label"
      value={value}
      onChange={onChange}
      options={options}
      {...selectProps}
    />
  );
};
