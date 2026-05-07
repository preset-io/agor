/**
 * Transport DTOs for the daemon's `/templates` Handlebars renderer.
 *
 * Lives in core/types so the daemon service, the @agor-live/client typing,
 * and any future consumer can share one shape — no parallel definitions.
 */

import type { RenderTemplateOnError } from '../templates/handlebars-helpers';

export interface TemplateRenderRequest {
  /** Handlebars template source. */
  template: string;
  /** Context object passed to the template. */
  context?: Record<string, unknown>;
  /**
   * Behaviour when render fails: `'empty'` (default) returns `''`, `'raw'`
   * returns the unrendered template string. See `renderTemplate` in
   * `@agor/core/templates/handlebars-helpers` for the semantics.
   */
  onError?: RenderTemplateOnError;
}

export interface TemplateRenderResponse {
  rendered: string;
}
