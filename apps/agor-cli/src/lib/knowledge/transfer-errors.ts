import { knowledgeTransferValidationSummary } from '@agor/core/knowledge';
import { KNOWLEDGE_TRANSFER } from '@agor/core/types';
import type { KnowledgeProgress } from './progress';

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
    else
      detail = `Transfer request failed.${method === 'POST' ? ' An in-flight write may have committed.' : ''} Check connectivity and daemon availability; preserve the bundle and verify with --resume --dry-run before applying again.`;
    throw new Error(
      `${stage} — ${method} /${KNOWLEDGE_TRANSFER.path}${route === 'document' ? '/:id' : ''}${code ? ` (HTTP ${code})` : ''}: ${detail}`
    );
  }
}
