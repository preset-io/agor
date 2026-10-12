import { knowledgeTransferValidationSummary } from '@agor/core/knowledge';
import { KNOWLEDGE_TRANSFER } from '@agor/core/types';
import type { KnowledgeProgress } from './progress';

/** Only explicitly classified document failures permit scheduling more work. */
export class TransferRequestError extends Error {
  constructor(
    message: string,
    readonly continueDocuments: boolean
  ) {
    super(message);
  }
}

/** Bounded, sanitized diagnostics. An unsuccessful POST may already have committed. */
export class TransferFailures {
  count = 0;
  private details: string[] = [];

  capture(error: unknown, key: string, progress: KnowledgeProgress, sourceId?: unknown): void {
    if (!(error instanceof TransferRequestError) || !error.continueDocuments) throw error;
    this.count++;
    // Use canonical plan keys, never titles, content, URLs or remote error bodies.
    let label = /^d[0-9]{6}$/.test(key) ? key : 'document';
    if (
      typeof sourceId === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)
    )
      label += ` (source document ${sourceId})`;
    if (this.details.length < 20) {
      const detail = `${label}: ${error.message}`;
      this.details.push(detail);
      progress.summary(`Continuing after document failure — ${detail}`);
    }
  }

  finish(summary: string, guidance: string): void {
    if (!this.count) return;
    throw new Error(
      `${summary}; ${this.count} failed or unconfirmed. ${guidance}\n${this.details.join('\n')}${this.count > this.details.length ? `\n${this.count - this.details.length} additional failures omitted.` : ''}`
    );
  }
}

/** Do not print response bodies, URLs, headers, query values or raw Zod errors. */
export async function transferRequest<T>(
  progress: KnowledgeProgress,
  stage: string,
  method: 'GET' | 'POST',
  operation: () => Promise<T>,
  route: 'collection' | 'document' = 'collection'
): Promise<T> {
  try {
    return await progress.waiting(operation);
  } catch (error) {
    const remote = error as {
      code?: unknown;
      message?: unknown;
      data?: { issues?: unknown };
    } | null;
    const code =
      typeof remote?.code === 'number' &&
      Number.isInteger(remote.code) &&
      remote.code >= 400 &&
      remote.code <= 599
        ? remote.code
        : undefined;
    const issues = knowledgeTransferValidationSummary(remote?.data?.issues);
    const compatibility =
      'Check agor --version and the destination /health version for CLI/daemon compatibility.';
    // These server-owned messages have no interpolated input. Keep useful
    // non-schema reasons without printing arbitrary daemon/proxy error text.
    const safeRejection = [
      'Transfer request exceeds size limit',
      'Content does not match transfer plan',
      'Import exceeds namespace transfer limits',
      'Unsupported or oversized Knowledge version',
      'Unsupported or missing Knowledge version',
      'Document exceeds transfer limit',
    ].find((message) => message === remote?.message);
    let detail: string;
    if (code === 400)
      detail = `Request rejected${issues || safeRejection ? `: ${issues || safeRejection}` : ' (no field details supplied by daemon)'}. ${compatibility} Retrying --resume cannot repair a rejected request.`;
    else if (code === 401)
      detail = 'Authentication failed. Check the selected deployment and log in again.';
    else if (code === 403)
      detail =
        'Permission denied. Import requires member access; complete export requires workspace admin access.';
    else if (code === 404 && stage === 'Exporting document')
      detail =
        'Source document/version unavailable. Check the source; no incomplete export is published.';
    else if (code === 404 || code === 405)
      detail = `Transfer endpoint or source namespace unavailable. Check the destination URL and namespace slug. ${compatibility}`;
    else if (
      code === 409 &&
      (stage === 'Planning: source inventory' || stage === 'Exporting document')
    )
      detail =
        'Source conflict or checksum failure. Verify the source before retrying this export; do not import an incomplete export.';
    else if (code === 409)
      detail =
        'Destination conflict; nothing is overwritten. Resume requires the original bundle, importing user, and unchanged private destination; unrelated namespaces cannot be merged.';
    else if (code === 413)
      detail =
        'Request exceeds the server or proxy size limit. Check transfer limits before retrying.';
    else if (code === 429)
      detail =
        'Rate limited. Stopping requests; wait for the server limit to reset before resuming.';
    else {
      const guidance =
        stage === 'Exporting document' || stage === 'Planning: source inventory'
          ? 'Preserve the output directory; after resolving the error, resume the export with --resume.'
          : 'Preserve the bundle and verify with --resume --dry-run before applying again.';
      detail = `Transfer request failed.${method === 'POST' ? ' An in-flight write may have committed.' : ''} Check connectivity and daemon availability. ${guidance}`;
    }
    const documentStage =
      stage === 'Exporting document' ||
      stage === 'Importing document' ||
      stage === 'Reconciling references';
    const continueDocuments =
      documentStage &&
      (code === 409 ||
        code === 413 ||
        code === 500 ||
        (code === 404 && stage === 'Exporting document') ||
        (code === 400 &&
          Boolean(safeRejection) &&
          safeRejection !== 'Import exceeds namespace transfer limits'));
    // Unknown validation, auth, quota, rate limits, transport failures and service
    // unavailability are systemic: do not hammer the remaining plan or bypass it.
    throw new TransferRequestError(
      `${stage} — ${method} /${KNOWLEDGE_TRANSFER.path}${route === 'document' ? '/:id' : ''}${code ? ` (HTTP ${code})` : ''}: ${detail}`,
      continueDocuments
    );
  }
}
