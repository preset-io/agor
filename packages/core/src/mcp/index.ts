/**
 * MCP (Model Context Protocol) utilities
 */

export {
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
