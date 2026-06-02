/**
 * MCP (Model Context Protocol) utilities
 */

export {
  buildMCPTemplateContext,
  buildMCPTemplateContextFromEnv,
  DAEMON_RESERVED_CUSTOM_CONTEXT_KEYS,
  type MCPTemplateContext,
  type MCPTemplateResolutionResult,
  resolveMcpServerEnv,
  resolveMcpServersTemplates,
  resolveMcpServerTemplates,
} from './template-resolver';
