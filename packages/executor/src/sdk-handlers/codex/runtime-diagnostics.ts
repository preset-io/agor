import { randomUUID } from 'node:crypto';
import { sanitizeMCPExternalError } from '@agor/core/mcp';
import type { SessionID, TaskID } from '@agor/core/types';

/**
 * Executor operational channel only; never persist a provider object or copy it
 * to analytics. Session/task IDs come from the authorized invocation, not the SDK.
 * References are local random IDs, NOT provider item/call IDs or lookup authority.
 * No shared state: concurrent tasks/tenants cannot inherit another run's context.
 */
export class CodexRuntimeDiagnostics {
  private readonly runId = randomUUID();
  private sequence = 0;
  private omitted = 0;

  constructor(
    private readonly sessionId: SessionID,
    private readonly taskId?: TaskID
  ) {}

  record(
    event: 'item_notice' | 'mcp_tool_failed',
    error: unknown,
    failureKind?: 'call_error' | 'failed_result' | 'failed_item'
  ): string {
    const reference = `${this.runId}:${++this.sequence}`;
    // Keep every outcome visible in the conversation, but cap operational volume.
    if (this.sequence > 20) {
      this.omitted++;
      return reference;
    }
    const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
    const { code, status, type } = safe.diagnostic;
    console.warn(
      `[codex.runtime] event=${event} reference=${reference} session_id=${this.sessionId}` +
        `${this.taskId ? ` task_id=${this.taskId}` : ''}` +
        ` category=${safe.category} type=${type}` +
        `${failureKind ? ` failure_kind=${failureKind}` : ''}` +
        `${code ? ` code=${code}` : ''}${status !== undefined ? ` status=${status}` : ''}` +
        ` outcome=${event === 'item_notice' ? 'notice_origin_unknown' : 'tool_failed_write_outcome_unknown'}`
    );
    return reference;
  }

  finish(): void {
    if (this.omitted === 0) return;
    console.warn(
      `[codex.runtime] event=diagnostics_limited run_id=${this.runId}` +
        ` session_id=${this.sessionId}${this.taskId ? ` task_id=${this.taskId}` : ''}` +
        ` omitted=${this.omitted}`
    );
    this.omitted = 0;
  }
}

export function codexRuntimeNotice(reference: string): string {
  // Codex 0.153 exec JSONL maps config warnings, deprecations, model rerouting,
  // and general warnings to the same {type:'error', id, message} item. It does
  // not retain their discriminators. Do not infer MCP, retryability, or success
  // from that lossy shape, nor parse/echo provider-controlled prose.
  return (
    '[Codex runtime notice] Codex reported a non-fatal notice; the turn is still running. ' +
    'This does not establish whether a tool succeeded or failed. If it recurs, ask an administrator ' +
    `to review the operational diagnostics (reference=${reference}). Check write outcomes before retrying.`
  );
}

export const CODEX_MCP_UNKNOWN_FAILURE =
  'The MCP tool call failed. A write may already have taken effect; check the resulting state before retrying. ' +
  'If it continues, ask an administrator to review the operational diagnostics.';
