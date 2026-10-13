import { BadRequest } from '@agor/core/feathers';
import { isMcpMemberPolicyRefusal, MCP_MEMBER_POLICY_REFUSED_CODE } from '@agor/core/mcp';

const MAX_ISSUES = 8;
const QUERY_FIELDS = new Set([
  'board_id',
  'branch_id',
  'repo_id',
  'card_id',
  'zone_id',
  'entity_type',
  'exclude_archived_branches',
  'archived',
  'lean',
  'name',
  'slug',
  'created_by',
  'created_at',
  'updated_at',
  '$limit',
  '$skip',
  '$sort',
  '$select',
]);
const VALIDATION_CODES = new Set([
  'type',
  'format',
  'pattern',
  'required',
  'additionalProperties',
  'anyOf',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'invalid_type',
  'invalid_value',
  'invalid_format',
  'too_small',
  'too_big',
  'unrecognized_keys',
  'invalid_union',
  'custom',
]);

interface ValidationIssue {
  field: string;
  code: string;
}

/** Only schema-known top-level fields and fixed codes; never values or dynamic record keys. */
export function inputValidationIssues(error: unknown, schema: unknown): ValidationIssue[] {
  const shape = schema && typeof schema === 'object' && 'shape' in schema ? schema.shape : {};
  const fields = new Set(Object.keys(shape ?? {}));
  const issues = error && typeof error === 'object' && 'issues' in error ? error.issues : [];
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    field: fields.has(issue.path?.[0]) ? issue.path[0] : 'arguments',
    code: VALIDATION_CODES.has(issue.code) ? issue.code : 'invalid',
  }));
}

export class McpInputValidationError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[] = []
  ) {
    super(message);
  }
}

/** Preserve the old error/tool fields while identifying where validation failed. */
export function mcpValidationFailure(error: unknown, tool: string) {
  const inputError = error instanceof McpInputValidationError;
  const serviceError = error instanceof BadRequest && error.message === 'validation failed';
  if (!inputError && !serviceError) return undefined;
  const issues: ValidationIssue[] = inputError
    ? error.issues
    : Array.isArray(error.data)
      ? error.data.slice(0, MAX_ISSUES).map((issue) => {
          const field =
            typeof issue?.instancePath === 'string' ? issue.instancePath.split('/')[1] : '';
          return {
            field: QUERY_FIELDS.has(field) ? field : 'query',
            code: VALIDATION_CODES.has(issue?.keyword) ? issue.keyword : 'invalid',
          };
        })
      : [];
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: error.message,
          tool,
          code: inputError ? 'invalid_tool_arguments' : 'service_validation_failed',
          validation_stage: inputError ? 'tool_input' : 'service',
          issues,
          retryable: false,
          hint: inputError
            ? 'Correct the indicated fields using agor_get_tool_details before retrying.'
            : 'A downstream service rejected the request. Check the indicated fields against agor_get_tool_details; if your payload matches, report a tool/service schema mismatch. Do not retry unchanged.',
        }),
      },
    ],
    isError: true,
  };
}

/**
 * The member policy refusing an MCP server write, shaped like the failures
 * above so an agent acting for a member stops and hands the request to an admin
 * rather than retrying or trying another way to configure the server.
 */
export function mcpMemberPolicyRefusal(error: unknown, tool: string) {
  if (!isMcpMemberPolicyRefusal(error)) return undefined;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: (error as Error).message,
          tool,
          code: MCP_MEMBER_POLICY_REFUSED_CODE,
          retryable: false,
          hint: 'In this workspace only administrators can add or change MCP servers. Do not retry or try another way to configure it. Tell the user to ask a workspace administrator to add the server they need; once it exists they can connect it and use it.',
        }),
      },
    ],
    isError: true,
  };
}
