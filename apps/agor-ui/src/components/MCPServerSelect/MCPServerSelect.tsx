import { type MCPServer, shortId } from '@agor-live/client';
import { Checkbox, Select, type SelectProps, Typography, theme } from 'antd';
import { useAgorStore } from '../../store/agorStore';
import { selectUserAuthenticatedMcpServerIds } from '../../store/selectors';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';

export interface MCPServerSelectProps extends Omit<SelectProps, 'options' | 'variant'> {
  mcpServers: MCPServer[];
  value?: string[];
  onChange?: (value: string[]) => void;
  placeholder?: string;
  filterByScope?: 'global' | 'repo' | 'session';
  /**
   * `select` (default) shows a searchable multi-select. `list` renders the
   * servers directly as a values-first checkbox list for popover surfaces where
   * one click should reveal the options with no nested dropdown.
   */
  variant?: 'select' | 'list';
}

/**
 * How an install that never finished reads in the picker.
 *
 * Connecting a catalog entry creates the row before anyone signs in, so an
 * OAuth install sits in this list looking exactly like a working one. Saying so
 * in the label — rather than in a suffix only the renderer sees — keeps it in
 * whatever `optionFilterProp="label"` searches.
 */
export const NEEDS_AUTH_OPTION_SUFFIX = ' · Not signed in';

export function buildMcpServerOptions(
  mcpServers: MCPServer[],
  selectedIds: string[] = [],
  /**
   * Servers this user has a live OAuth grant for. Defaults to empty, which is
   * the honest reading for a caller that has no store: `mcpServerNeedsAuth`
   * still clears any server carrying an unexpired access token.
   */
  userAuthenticatedMcpServerIds: Set<string> = new Set()
) {
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
      const needsAuthSuffix = mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)
        ? NEEDS_AUTH_OPTION_SUFFIX
        : '';
      return {
        label: `${name} (${server.transport})${authSuffix}${needsAuthSuffix}`,
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
 * - Marks servers whose OAuth sign-in never happened
 */
export const MCPServerSelect: React.FC<MCPServerSelectProps> = ({
  mcpServers,
  value,
  onChange,
  placeholder = 'Select MCP servers...',
  filterByScope,
  variant = 'select',
  ...selectProps
}) => {
  const { token } = theme.useToken();
  // Read here rather than as a prop: every caller of this picker would
  // otherwise have to thread the same set through, and one that forgot would
  // quietly go back to showing an unfinished install as a working one.
  const userAuthenticatedMcpServerIds = useAgorStore(selectUserAuthenticatedMcpServerIds);

  // Filter servers by scope if specified
  const filteredServers = filterByScope
    ? mcpServers.filter((server) => server.scope === filterByScope)
    : mcpServers;

  const options = buildMcpServerOptions(filteredServers, value, userAuthenticatedMcpServerIds);

  // Values-first list: render the servers directly as checkboxes so a popover
  // shows them on the first click, with no nested multi-select dropdown.
  if (variant === 'list') {
    if (options.length === 0) {
      return <Typography.Text type="secondary">No MCP servers available</Typography.Text>;
    }
    return (
      <Checkbox.Group
        value={value}
        onChange={(vals) => onChange?.(vals as string[])}
        style={{ display: 'flex', flexDirection: 'column', gap: token.marginXS, width: '100%' }}
      >
        {options.map((opt) => (
          <Checkbox key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </Checkbox>
        ))}
      </Checkbox.Group>
    );
  }

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
