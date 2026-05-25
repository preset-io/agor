/**
 * Cursor SDK Handler (experimental skeleton)
 *
 * The provider is type-plumbed behind `execution.cursor_sdk_enabled`, but the
 * runtime adapter is intentionally deferred until a live SDK smoke test verifies
 * headless execution, permission behavior, MCP events, and usage metrics.
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import type { AgorClient } from '../../services/feathers-client.js';

export async function executeCursorTask(_params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  resolvedConfig?: ResolvedConfigSlice;
}): Promise<void> {
  throw new Error(
    'Cursor SDK execution is not implemented yet. Enable only after the experimental runtime adapter lands.'
  );
}
