/**
 * Templates Service
 *
 * Server-side Handlebars renderer. Exists so the browser can render templates
 * without bundling Handlebars (which uses `new Function` and would require CSP
 * `script-src 'unsafe-eval'`). The daemon has no CSP, so it runs Handlebars
 * freely and returns the rendered string.
 *
 * Used by the UI for:
 *   - Zone-trigger templates (user-defined, stored on zones)
 *   - Env health-URL templates (worktree env config)
 *   - The bundled spawn-subsession prompt template (`spawn_subsession.hbs`)
 *
 * Endpoint: POST /templates  body: { template, context, onError? } → { rendered }
 */

import {
  type RenderTemplateOnError,
  renderTemplate,
} from '@agor/core/templates/handlebars-helpers';
import type { AuthenticatedParams } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';

export interface TemplateRenderRequest {
  /** Handlebars template source. */
  template: string;
  /** Context object passed to the template. */
  context?: Record<string, unknown>;
  /**
   * Behaviour when render fails: `'empty'` (default) returns `''`, `'raw'`
   * returns the unrendered template string. See `renderTemplate` in
   * @agor/core for the semantics.
   */
  onError?: RenderTemplateOnError;
}

export interface TemplateRenderResponse {
  rendered: string;
}

export class TemplatesService {
  async create(
    data: TemplateRenderRequest,
    params?: AuthenticatedParams
  ): Promise<TemplateRenderResponse> {
    ensureMinimumRole(params, ROLES.MEMBER, 'render templates');

    if (typeof data?.template !== 'string') {
      throw new Error('template (string) is required');
    }
    const context = data.context && typeof data.context === 'object' ? data.context : {};
    const rendered = renderTemplate(data.template, context, { onError: data.onError ?? 'empty' });
    return { rendered };
  }
}

export function createTemplatesService(): TemplatesService {
  return new TemplatesService();
}
