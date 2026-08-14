import { BadRequest } from '@agor/core/feathers';
import {
  type HookContext,
  MESSAGE_TYPE_VALUES,
  type MessageCreate,
  MessageRole,
} from '@agor/core/types';

const MESSAGE_CREATE_FIELDS = new Set<keyof MessageCreate>([
  'message_id',
  'session_id',
  'task_id',
  'type',
  'role',
  'index',
  'timestamp',
  'content_preview',
  'content',
  'tool_uses',
  'parent_tool_use_id',
  'metadata',
]);
const MESSAGE_TYPES = new Set<string>(MESSAGE_TYPE_VALUES);
const MESSAGE_ROLES = new Set<string>(Object.values(MessageRole));

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Runtime counterpart to the public MessageCreate DTO. */
export function assertMessageCreatePayload(data: unknown): asserts data is MessageCreate {
  if (Array.isArray(data)) throw new BadRequest('Bulk Message create is not supported');
  if (data === null || typeof data !== 'object') {
    throw new BadRequest('Message create payload must be an object');
  }

  const input = data as Record<string, unknown>;
  const unsupported = Object.keys(input).filter(
    (field) => !MESSAGE_CREATE_FIELDS.has(field as keyof MessageCreate)
  );
  if (unsupported.length > 0) {
    throw new BadRequest(`Unsupported Message create fields: ${unsupported.join(', ')}`);
  }

  if (input.message_id !== undefined && !isNonEmptyString(input.message_id)) {
    throw new BadRequest('message_id must be a non-empty string when provided');
  }
  if (!isNonEmptyString(input.session_id)) {
    throw new BadRequest('session_id is required');
  }
  if (input.task_id !== undefined && !isNonEmptyString(input.task_id)) {
    throw new BadRequest('task_id must be a non-empty string when provided');
  }
  if (!MESSAGE_TYPES.has(String(input.type))) {
    throw new BadRequest('Unsupported Message type');
  }
  if (!MESSAGE_ROLES.has(String(input.role))) {
    throw new BadRequest('Unsupported Message role');
  }
  if (!Number.isSafeInteger(input.index) || (input.index as number) < 0) {
    throw new BadRequest('index must be a non-negative integer');
  }
  if (!isNonEmptyString(input.timestamp) || !Number.isFinite(Date.parse(input.timestamp))) {
    throw new BadRequest('timestamp must be a valid date string');
  }
  if (typeof input.content_preview !== 'string') {
    throw new BadRequest('content_preview must be a string');
  }
  if (
    !Object.hasOwn(input, 'content') ||
    input.content === null ||
    !['string', 'object'].includes(typeof input.content)
  ) {
    throw new BadRequest('content must be a string, content-block array, or request object');
  }
  if (input.tool_uses !== undefined && !Array.isArray(input.tool_uses)) {
    throw new BadRequest('tool_uses must be an array when provided');
  }
  if (
    input.parent_tool_use_id !== undefined &&
    input.parent_tool_use_id !== null &&
    typeof input.parent_tool_use_id !== 'string'
  ) {
    throw new BadRequest('parent_tool_use_id must be a string or null when provided');
  }
  if (
    input.metadata !== undefined &&
    (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata))
  ) {
    throw new BadRequest('metadata must be an object when provided');
  }
}

/** Validate before RBAC/widget hooks inspect fields on an external payload. */
export function validateMessageCreate(context: HookContext): HookContext {
  assertMessageCreatePayload(context.data);
  return context;
}
