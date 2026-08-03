/**
 * MCP (Model Context Protocol) utilities
 */

export {
  filterMCPServersForSession,
  isMCPServerUsableBy,
  isMCPServerUsableInSession,
  MCPServerNotUsableError,
  type MCPServerOwnership,
  type MCPServerSessionIdentity,
} from './ownership';
export {
  AGOR_MCP_SERVER_NAME,
  getMcpServersForSession,
  type MCPAuthHeadersRepository,
  type MCPResolutionDeps,
  type MCPScopingServerRepository,
  type MCPScopingSessionRepository,
  type MCPServerWithSource,
} from './scoping';
export {
  buildMCPTemplateContextFromEnv,
  containsTemplate,
  isUserEnvPlaceholder,
  type MCPTemplateContext,
  type MCPTemplateResolutionResult,
  resolveMcpServerEnv,
  resolveMcpServersTemplates,
  resolveMcpServerTemplates,
  TEMPLATE_RESOLVABLE_MCP_AUTH_SECRET_FIELDS,
} from './template-resolver';
export {
  canEnforceMcpToolPermissions,
  type HandlerPermissionCapabilities,
  listMcpToolsWithPermission,
  PERMISSIONS_BLOCKED_WITHOUT_PROMPT,
} from './tool-permissions';
