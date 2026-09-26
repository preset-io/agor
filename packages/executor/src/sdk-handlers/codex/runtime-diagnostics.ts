import { randomUUID } from 'node:crypto';
import { sanitizeMCPExternalError } from '@agor/core/mcp';
import type { SessionID, TaskID } from '@agor/core/types';

// Codex SDK 0.156.1 forwards native spawn/filesystem errors. Do not log their
// path, syscall, spawnargs, or message. These codes describe a runtime failure,
// not its root cause (ENOENT, for example, does not prove an auth-file problem).
const RUNTIME_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'EPIPE',
]);

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
  private terminalRecorded = false;

  constructor(
    private readonly sessionId: SessionID,
    private readonly taskId?: TaskID
  ) {}

  recordFailure(
    event:
      | 'stream_error_observed'
      | 'turn_completed_without_response'
      | 'turn_failed'
      | 'stream_start_failed'
      | 'stream_interrupted'
      | 'stream_ended_without_completion',
    error: unknown,
    category?: 'configuration_required'
  ): void {
    const terminal = event !== 'stream_error_observed';
    // Share the notice budget, but reserve one terminal diagnostic even after
    // a flood of notices/reconnect notifications. No provider-driven retries.
    if (terminal && this.terminalRecorded) return;
    const reference = `${this.runId}:${++this.sequence}`;
    if (!terminal && this.sequence > 20) {
      this.omitted++;
      return;
    }
    if (terminal) this.terminalRecorded = true;

    const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
    const { status, type } = safe.diagnostic;
    let { code } = safe.diagnostic;
    let runtimeCode: string | undefined;
    try {
      const descriptor =
        error !== null && (typeof error === 'object' || typeof error === 'function')
          ? Object.getOwnPropertyDescriptor(error, 'code')
          : undefined;
      const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (typeof value === 'string' && RUNTIME_CODES.has(value)) runtimeCode = value;
    } catch {
      // Malformed/hostile runtime objects are opaque, never a logging failure.
    }
    const runtimeFailure = runtimeCode !== undefined && status === undefined && code === undefined;
    if (runtimeFailure) code = runtimeCode;
    // No prose parsing. The pinned SDK's ThreadError/ThreadErrorEvent have only
    // message; CLI exits and JSONL parse errors are also prose-only Error objects.
    // In particular TypeError alone is not evidence of provider unavailability.
    const classification =
      category ??
      (runtimeFailure
        ? 'runtime_failure'
        : code || status !== undefined
          ? safe.category
          : 'unknown');
    const message =
      `[codex.runtime] event=${event} reference=${reference} session_id=${this.sessionId}` +
      `${this.taskId ? ` task_id=${this.taskId}` : ''}` +
      ` category=${classification} type=${runtimeFailure ? 'SystemError' : type}` +
      `${code ? ` code=${code}` : ''}${status !== undefined ? ` status=${status}` : ''}` +
      ` metadata=${code || status !== undefined ? 'structured' : 'unavailable'}`;
    if (terminal) console.error(message);
    else console.warn(`${message} outcome=awaiting_terminal_event`);
  }

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
