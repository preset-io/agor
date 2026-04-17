import { isWorktreeRbacEnabled } from '@agor/core/config';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  messages as messagesTable,
  or,
  SessionRepository,
  select,
  sql,
} from '@agor/core/db';
import type { ContentBlock } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isSuperAdmin } from '../../utils/worktree-authorization.js';
import { resolveSessionId, resolveTaskId } from '../resolve-ids.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

export function registerMessageTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_messages_list
  server.registerTool(
    'agor_messages_list',
    {
      description:
        'Page through session conversation messages or search across sessions by keyword. When sessionId is provided, returns messages chronologically (like reading a transcript). When search is provided without sessionId, finds messages across all sessions. Tool calls are filtered out by default for cleaner output.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: z
          .string()
          .optional()
          .describe('Session ID to scope messages to (optional when using search)'),
        taskId: z.string().optional().describe('Task ID to scope messages to (optional)'),
        search: z
          .string()
          .optional()
          .describe(
            'Keyword search across message content. Space-separated terms are AND\'d, pipe (|) for OR. Example: "OAuth middleware" requires both; "OAuth | JWT" matches either.'
          ),
        includeToolCalls: z
          .boolean()
          .optional()
          .describe(
            'Include tool call messages and tool_use content blocks (default: false). When false, strips tool noise for cleaner output.'
          ),
        contentMode: z
          .enum(['preview', 'full'])
          .optional()
          .describe(
            'Content detail level. "preview" returns first 200 chars (default). "full" returns complete text content.'
          ),
        limit: z.number().optional().describe('Maximum number of messages to return (default: 20)'),
        offset: z.number().optional().describe('Skip first N messages (default: 0)'),
        order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe(
            'Sort order by message index. Default: "asc" when browsing a session, "desc" when searching.'
          ),
        role: z.enum(['user', 'assistant']).optional().describe('Filter by message role'),
      }),
    },
    async (args) => {
      const sessionIdRaw = coerceString(args.sessionId);
      const taskIdRaw = coerceString(args.taskId);
      const search = coerceString(args.search);

      if (!sessionIdRaw && !taskIdRaw && !search) {
        throw new Error('at least one of sessionId, taskId, or search is required');
      }

      const sessionId = sessionIdRaw ? await resolveSessionId(ctx, sessionIdRaw) : undefined;
      const taskId = taskIdRaw ? await resolveTaskId(ctx, taskIdRaw) : undefined;

      const includeToolCalls = args.includeToolCalls === true;
      const contentMode = args.contentMode === 'full' ? 'full' : 'preview';
      const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
      const limit = Math.min(Math.max(0, Math.floor(rawLimit)) || 20, 100);
      const rawOffset = typeof args.offset === 'number' ? args.offset : 0;
      const offset = Math.max(0, Math.floor(rawOffset)) || 0;
      const order =
        args.order === 'asc' || args.order === 'desc'
          ? args.order
          : search && !sessionId
            ? 'desc'
            : 'asc';
      const role = args.role === 'user' || args.role === 'assistant' ? args.role : undefined;

      // Build WHERE conditions
      const conditions = [];
      if (sessionId) conditions.push(eq(messagesTable.session_id, sessionId));
      if (taskId) conditions.push(eq(messagesTable.task_id, taskId));
      if (role) conditions.push(eq(messagesTable.role, role));

      if (!includeToolCalls) {
        conditions.push(
          sql`${messagesTable.type} NOT IN ('file-history-snapshot', 'permission_request', 'input_request')`
        );
      }

      // Search: parse "term1 term2 | term3 term4" into (t1 AND t2) OR (t3 AND t4)
      if (search) {
        const orGroups = search.split(/\s*\|\s*/).map((group) => {
          const terms = group.trim().split(/\s+/).filter(Boolean);
          return terms.map(
            (term) =>
              sql`LOWER(CAST(${messagesTable.data} AS TEXT)) LIKE ${`%${term.toLowerCase()}%`}`
          );
        });
        const searchCondition =
          orGroups.length === 1
            ? and(...orGroups[0])
            : or(...orGroups.map((andTerms) => and(...andTerms)));
        if (searchCondition) conditions.push(searchCondition);
      }

      // RBAC enforcement: when worktree_rbac is enabled, restrict this search
      // to sessions the caller can access. Superadmins bypass. When RBAC is
      // disabled (default / open-access mode), skip this filter entirely to
      // preserve backward-compatible behavior.
      if (isWorktreeRbacEnabled()) {
        const userRole = ctx.authenticatedUser?.role as string | undefined;
        if (!isSuperAdmin(userRole)) {
          const sessionRepo = new SessionRepository(ctx.db);
          const accessibleSessions = await sessionRepo.findAccessibleSessions(ctx.userId);
          const accessibleIds = accessibleSessions.map((s) => s.session_id);
          if (accessibleIds.length === 0) {
            return textResult({ messages: [], total: 0, offset, limit });
          }
          conditions.push(inArray(messagesTable.session_id, accessibleIds));
        }
      }

      const orderCol = sessionId ? messagesTable.index : messagesTable.timestamp;
      const orderBy = order === 'desc' ? desc(orderCol) : asc(orderCol);
      const allRows = await select(ctx.db)
        .from(messagesTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderBy)
        .all();

      // Post-process
      type ProcessedMessage = {
        message_id: string;
        session_id: string;
        index: number;
        role: string;
        timestamp: string;
        task_id?: string;
        text: string;
        tool_call_count?: number;
      };

      const processed: ProcessedMessage[] = [];

      for (const row of allRows) {
        const data = row.data as {
          content?: unknown;
          tool_uses?: unknown[];
          metadata?: unknown;
        };
        const content = data?.content;

        if (!includeToolCalls && row.role === 'user' && Array.isArray(content)) {
          const hasNonToolResult = (content as ContentBlock[]).some(
            (block) => block.type !== 'tool_result'
          );
          if (!hasNonToolResult) continue;
        }

        let text: string;
        let toolCallCount = 0;

        if (contentMode === 'preview') {
          text = row.content_preview || '';
        } else {
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            const blocks = content as ContentBlock[];
            const textBlocks: string[] = [];
            for (const block of blocks) {
              if (block.type === 'text' && typeof block.text === 'string') {
                textBlocks.push(block.text);
              } else if (block.type === 'tool_use') {
                toolCallCount++;
              }
            }
            text = textBlocks.join('\n\n');
          } else {
            text = row.content_preview || '';
          }
        }

        if (contentMode === 'preview' && Array.isArray(content)) {
          for (const block of content as ContentBlock[]) {
            if (block.type === 'tool_use') toolCallCount++;
          }
        }

        if (!includeToolCalls && row.role === 'assistant' && !text.trim()) {
          continue;
        }

        const msg: ProcessedMessage = {
          message_id: row.message_id,
          session_id: row.session_id,
          index: row.index,
          role: row.role,
          timestamp:
            row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
          text,
        };
        if (row.task_id) msg.task_id = row.task_id;
        if (toolCallCount > 0) msg.tool_call_count = toolCallCount;
        processed.push(msg);
      }

      const total = processed.length;
      const paged = processed.slice(offset, offset + limit);
      return textResult({ messages: paged, total, offset, limit });
    }
  );
}
