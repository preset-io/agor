/**
 * Transport DTOs for the daemon's `/templates` Handlebars renderer.
 *
 * Lives in core/types so the daemon service, the @agor-live/client typing,
 * and any future consumer can share one shape — no parallel definitions.
 *
 * `RenderTemplateOnError` lives here (rather than alongside the Handlebars
 * implementation) so the browser-facing client types don't transitively
 * pull in a Handlebars-coupled module.
 */

/**
 * Behaviour when a template fails to render.
 *
 * - `'empty'` (default): return `''`. Safe for callers that compose the
 *   result into shell commands, env vars, system prompts, etc., where
 *   leaking unresolved `{{...}}` placeholders is worse than emptiness.
 * - `'raw'`: return the raw template string so users see *something*
 *   (the unrendered placeholders). Use for UI surfaces like the zone
 *   trigger preview dialog where a blank textarea hides the bug.
 */
export type RenderTemplateOnError = 'empty' | 'raw';

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
