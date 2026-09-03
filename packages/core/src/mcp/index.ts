/**
 * MCP (Model Context Protocol) utilities
 */

export {
  assertValidMCPAuthPatch,
  MCPAuthValidationError,
  mergeMCPAuth,
  replaceMCPAuth,
} from '../tools/mcp/auth-patch';
export {
  asMCPExternalError,
  isMCPAbortError,
  MCPExternalError,
  type MCPExternalErrorAction,
  type MCPExternalErrorCategory,
  type MCPExternalErrorStage,
  type SanitizedMCPExternalError,
  sanitizeMCPExternalError,
} from '../tools/mcp/external-error';
export {
  assertValidDiscoveredMCPCapabilities,
  assertValidEffectiveMCPServer,
  assertValidMCPServerWrite,
  MCPServerWriteValidationError,
} from '../tools/mcp/server-validation';
export {
  canConfigureMCPServers,
  isAtLeastMemberRole,
  isMcpGrantSubjectEntitled,
  MEMBER_PRIVATE_MCP_SCOPE,
  mayMemberManageMCPServer,
  mayMemberUseMCPScope,
  mayMemberUseMCPTransport,
  mayMemberWriteMCPServers,
} from './member-policy';
export {
  filterMCPServersForSession,
  isMCPServerUsableBy,
  isMCPServerUsableInSession,
  MCPServerNotUsableError,
} from './ownership';
export {
  MCP_RUNTIME_PROVIDER_CAPABILITIES,
  mcpRuntimeProviderCapability,
} from './runtime-refresh';
export {
  AGOR_MCP_SERVER_NAME,
  getMcpServersForSession,
  type MCPAuthHeadersRepository,
  MCPOAuthAuthorityUnavailableError,
  type MCPOAuthAuthResolution,
  type MCPResolutionDeps,
  type MCPScopingServerRepository,
  type MCPScopingSessionRepository,
  type MCPServerWithSource,
  resolveScopedMCPAuthHeaders,
} from './scoping';
export {
  buildMCPTemplateContextFromEnv,
  containsTemplate,
  extractMCPTemplateDependencies,
  hasTemplateMarker,
  isUserEnvPlaceholder,
  type MCPTemplateContext,
  type MCPTemplateDependencies,
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
