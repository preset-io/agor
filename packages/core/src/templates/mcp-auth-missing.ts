import type { UnavailableMcpServer } from '../mcp/scoping';

export interface RenderMcpAuthMissingContextInput {
  unavailable: readonly UnavailableMcpServer[];
  baseUrl: string;
}

function mcpSettingsUrl(baseUrl: string, serverId: string): string {
  let base = baseUrl.replace(/\/$/, '');
  if (base.endsWith('/ui')) base = base.slice(0, -3);
  return `${base}/ui/settings/mcp/${encodeURIComponent(serverId)}/`;
}

/** Render dynamic MCP authentication state for one provider-facing turn. */
export function renderMcpAuthMissingContext({
  unavailable,
  baseUrl,
}: RenderMcpAuthMissingContextInput): string {
  if (unavailable.length === 0) return '';

  const servers = unavailable.map(({ server: { server } }) => {
    const displayName = server.display_name || server.name;
    return `- Display name ${JSON.stringify(displayName)}; server ID \`${server.mcp_server_id}\`; authenticate: ${mcpSettingsUrl(baseUrl, server.mcp_server_id)}`;
  });

  return [
    '[Agor runtime context]',
    'These configured OAuth MCP servers require authentication and are unavailable for this turn:',
    ...servers,
    "Mention this only if relevant to the user's request.",
    '[/Agor runtime context]',
  ].join('\n');
}
