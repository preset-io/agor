import { type MCPServer, shortId } from '@agor-live/client';
import { Select, type SelectProps } from 'antd';

export interface MCPServerSelectProps extends Omit<SelectProps, 'options'> {
  mcpServers: MCPServer[];
  value?: string[];
  onChange?: (value: string[]) => void;
  placeholder?: string;
  filterByScope?: 'global' | 'repo' | 'session';
}

export function buildMcpServerOptions(mcpServers: MCPServer[], selectedIds: string[] = []) {
  const selected = new Set(selectedIds);
  const options: Array<{ label: string; value: string; disabled: boolean }> = mcpServers
    // Disabled servers cannot be newly attached, but must remain an option when
    // already selected. Otherwise Ant Select falls back to rendering the UUID.
    .filter((server) => server.enabled || selected.has(server.mcp_server_id))
    .map((server) => {
      const name =
        server.display_name || server.name || `MCP server ${shortId(server.mcp_server_id)}`;
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
    });

  const knownIds = new Set<string>(mcpServers.map((server) => server.mcp_server_id));
  for (const id of selectedIds) {
    if (!knownIds.has(id)) {
      options.push({
        label: `Unavailable MCP server (${shortId(id)})`,
        value: id,
        disabled: true,
      });
    }
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
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

  const options = buildMcpServerOptions(filteredServers, value);

  return (
    <Select
      mode="multiple"
      placeholder={placeholder}
      allowClear
      showSearch
      optionFilterProp="label"
      notFoundContent={mcpServers.length === 0 ? 'No MCP servers available' : 'No matching servers'}
      value={value}
      onChange={onChange}
      options={options}
      {...selectProps}
    />
  );
};
