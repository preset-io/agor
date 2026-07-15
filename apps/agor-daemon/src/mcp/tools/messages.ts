import { isBranchRbacEnabled } from '@agor/core/config';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  lte,
  messages as messagesTable,
  or,
  type SQL,
  select,
  sql,
  visibleSessionReferenceAccessExists,
} from '@agor/core/db';
import type { ContentBlock } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isSuperAdmin } from '../../utils/branch-authorization.js';
import { resolveSessionId, resolveTaskId } from '../resolve-ids.js';
import { mcpLimit, mcpOffset, mcpOptionalId, mcpOptionalString } from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

const BROAD_SEARCH_GUIDANCE =
  'Broad cross-session message search must be scoped to sessionId/taskId or bounded with createdAfter. Use a window of 31 days or less; add createdBefore for historical searches. Example: { "search": "SEO", "createdAfter": "2026-06-01T00:00:00Z", "createdBefore": "2026-06-15T00:00:00Z" }. This prevents full-table scans on large message databases.';

const MAX_CROSS_SESSION_SEARCH_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function parseDateArg(name: string, value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${name} must be an ISO-8601 date string, for example "2026-06-01T00:00:00Z".`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `${name} must be a valid ISO-8601 date string, for example "2026-06-01" or "2026-06-01T00:00:00Z".`
    );
  }
  return date;
}

export function registerMessageTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_messages_list
  server.registerTool(
    'agor_messages_list',
    {
      description:
        'Page through session conversation messages or search across sessions by keyword. When sessionId is provided, returns messages chronologically (like reading a transcript). When search is provided without sessionId, finds messages across all sessions. Tool calls are filtered out by default for cleaner output.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpOptionalId(
          'sessionId',
          'Session',
          'Session ID to scope messages to (optional when using search)'
        ),
        taskId: mcpOptionalId('taskId', 'Task', 'Task ID to scope messages to (optional)'),
        search: mcpOptionalString(
          'search',
          'Keyword search across message content. Space-separated terms are AND\'d, pipe (|) for OR. Example: "OAuth middleware" requires both; "OAuth | JWT" matches either. Cross-session search must include sessionId/taskId or a createdAfter-bounded window of 31 days or less.'
        ),
        createdAfter: mcpOptionalString(
          'createdAfter',
          'Only include messages at or after this message timestamp. ISO-8601 date/time, e.g. "2026-06-01" or "2026-06-01T00:00:00Z". Recommended for broad searches.'
        ),
        createdBefore: mcpOptionalString(
          'createdBefore',
          'Only include messages before or at this message timestamp. ISO-8601 date/time, e.g. "2026-06-28T23:59:59Z". Use with createdAfter for historical cross-session searches.'
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
        limit: mcpLimit(20),
        offset: mcpOffset(0),
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
      const createdAfter = parseDateArg('createdAfter', args.createdAfter);
      const createdBefore = parseDateArg('createdBefore', args.createdBefore);

      if (createdAfter && createdBefore && createdAfter.getTime() > createdBefore.getTime()) {
        throw new Error('createdAfter must be earlier than or equal to createdBefore.');
      }

      if (!sessionIdRaw && !taskIdRaw && !search) {
        throw new Error(
          'At least one of sessionId, taskId, or search must be provided as a non-empty string. Example: { "sessionId": "01abcdef" } or { "search": "OAuth middleware", "createdAfter": "2026-06-01T00:00:00Z" }.'
        );
      }

      if (search && !sessionIdRaw && !taskIdRaw) {
        if (!createdAfter) {
          throw new Error(BROAD_SEARCH_GUIDANCE);
        }
        const effectiveCreatedBefore = createdBefore ?? new Date();
        if (
          effectiveCreatedBefore.getTime() - createdAfter.getTime() >
          MAX_CROSS_SESSION_SEARCH_WINDOW_MS
        ) {
          throw new Error(BROAD_SEARCH_GUIDANCE);
        }
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
      const conditions: SQL[] = [];
      if (sessionId) conditions.push(eq(messagesTable.session_id, sessionId));
      if (taskId) conditions.push(eq(messagesTable.task_id, taskId));
      if (role) conditions.push(eq(messagesTable.role, role));
      if (createdAfter) conditions.push(gte(messagesTable.timestamp, createdAfter));
      if (createdBefore) conditions.push(lte(messagesTable.timestamp, createdBefore));

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

      // RBAC enforcement: when branch_rbac is enabled, restrict this search
      // to sessions the caller can access. Use the same SQL EXISTS predicate
      // as high-cardinality repository paths instead of materializing every
      // accessible session id into an IN (...) list.
      const orderCol = sessionId ? messagesTable.index : messagesTable.timestamp;
      const orderBy = order === 'desc' ? desc(orderCol) : asc(orderCol);
      // Keep every invocation bounded. The small over-fetch preserves the
      // existing "hide tool-only noise by default" behavior without loading
      // every matching row into daemon memory.
      const fetchLimit = Math.min(limit + 100, 200);
      const allRows = await runWithMcpTenantDatabaseScope(ctx, async (db) => {
        if (isBranchRbacEnabled()) {
          const userRole = ctx.authenticatedUser?.role as string | undefined;
          if (!isSuperAdmin(userRole)) {
            conditions.push(
              visibleSessionReferenceAccessExists(db, ctx.userId, messagesTable.session_id)
            );
          }
        }
        return select(db)
          .from(messagesTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(orderBy)
          .limit(fetchLimit)
          .offset(offset)
          .all();
      });

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
      let consumedRows = 0;

      for (const row of allRows) {
        if (processed.length >= limit) break;
        consumedRows++;
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

      const hasMore = allRows.length > consumedRows || allRows.length === fetchLimit;
      return textResult({
        messages: processed,
        returned: processed.length,
        offset,
        limit,
        scanned: allRows.length,
        scan_limit: fetchLimit,
        has_more: hasMore,
        next_offset: hasMore ? offset + consumedRows : undefined,
      });
    }
  );
}
