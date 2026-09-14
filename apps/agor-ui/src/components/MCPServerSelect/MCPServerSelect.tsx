import { type MCPServer, shortId } from '@agor-live/client';
import { ShopOutlined } from '@ant-design/icons';
import { Button, Empty, Select, type SelectProps } from 'antd';
import type { RefSelectProps } from 'antd/es/select';
import { type Ref, useImperativeHandle } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectUserAuthenticatedMcpServerIds } from '../../store/selectors';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { useMcpPopupLayout } from './useMcpPopupLayout';

export interface MCPServerSelectProps extends Omit<SelectProps, 'options'> {
  ref?: Ref<RefSelectProps>;
  mcpServers: MCPServer[];
  value?: string[];
  onChange?: (value: string[]) => void;
  placeholder?: string;
  onBrowseCatalog?: () => void;
  filterByScope?: 'global' | 'repo' | 'session';
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
        // Put status first so native tag ellipsis cannot hide it on phones.
        label: `${server.enabled ? '' : 'Disabled · '}${name} (${server.transport})${authSuffix}${needsAuthSuffix}`,
        value: server.mcp_server_id,
        // Disabled servers reach here only while selected. Let AntD remove
        // them (including with Backspace); after removal the filter above
        // drops the option, so they cannot be newly attached. Using the native
        // tags also preserves whole-field disabled and overflow behavior.
        disabled: false,
      };
    });

  const knownIds = new Set<string>(mcpServers.map((server) => server.mcp_server_id));
  for (const id of selectedIds) {
    if (!knownIds.has(id)) {
      options.push({
        label: `Unavailable MCP server (${shortId(id)})`,
        value: id,
        // This option exists only while selected. Keep it enabled so AntD
        // renders the tag's remove affordance; once detached it disappears
        // and cannot be selected again.
        disabled: false,
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
  onOpenChange,
  onDropdownVisibleChange,
  ref: forwardedRef,
  styles,
  onBrowseCatalog,
  ...selectProps
}) => {
  // Read here rather than as a prop: every caller of this picker would
  // otherwise have to thread the same set through, and one that forgot would
  // quietly go back to showing an unfinished install as a working one.
  const userAuthenticatedMcpServerIds = useAgorStore(selectUserAuthenticatedMcpServerIds);

  // Filter servers by scope if specified
  const filteredServers = filterByScope
    ? mcpServers.filter((server) => server.scope === filterByScope)
    : mcpServers;

  const popup = useMcpPopupLayout(selectProps);
  // Form.Item supplies a ref (React 19); preserve it without replacing the
  // geometry ref that owns list sizing.
  useImperativeHandle(forwardedRef, () => popup.ref.current!);

  // Explicit popup owners/alignment keep AntD's positioning contract. The
  // default viewport host instead uses measured fixed edges, avoiding rc-trigger
  // scroll/flip races and ancestor clipping without shifting over the field.
  const ownsPopup =
    !selectProps.getPopupContainer &&
    !selectProps.popupAlign &&
    !selectProps.placement &&
    !selectProps.builtinPlacements &&
    selectProps.popupMatchSelectWidth === undefined;

  const options = buildMcpServerOptions(filteredServers, value, userAuthenticatedMcpServerIds);

  return (
    <Select
      mode="multiple"
      placeholder={placeholder}
      allowClear
      showSearch
      optionFilterProp="label"
      notFoundContent={
        onBrowseCatalog ? (
          <Empty image={<ShopOutlined />} description="No matching MCP servers">
            <Button type="link" onClick={onBrowseCatalog}>
              Browse the MCP Catalog for all available MCPs
            </Button>
          </Empty>
        ) : mcpServers.length === 0 ? (
          'No MCP servers available'
        ) : (
          'No matching servers'
        )
      }
      value={value}
      onChange={onChange}
      options={options}
      ref={popup.ref}
      // A deliberate viewport host, not a guessed AntD overlay ancestor. Drawer
      // bodies AND Modal containers can clip; AntD owns the overlay z-index.
      getPopupContainer={(trigger) => trigger.ownerDocument.body}
      placement={popup.placement}
      listHeight={popup.listHeight}
      popupAlign={{
        htmlRegion: 'visible',
        offset: [0, 0],
        // Size to one side of the field instead of shifting a tall list over
        // its tags. Horizontal shifting is still needed near viewport edges.
        overflow: { adjustX: true, adjustY: false, shiftX: true, shiftY: false },
      }}
      {...selectProps}
      styles={(info) => {
        const overrides = typeof styles === 'function' ? styles(info) : styles;
        return {
          ...overrides,
          popup: {
            ...overrides?.popup,
            root: { ...(ownsPopup ? popup.style : undefined), ...overrides?.popup?.root },
          },
        };
      }}
      onOpenChange={(open) => {
        popup.setOpen(open);
        (onOpenChange ?? onDropdownVisibleChange)?.(open);
      }}
    />
  );
};
