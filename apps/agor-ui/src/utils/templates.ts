/**
 * Browser-side template rendering — delegates to the daemon's `/templates`
 * service so the UI bundle stays free of Handlebars (which uses `new Function`
 * and would require CSP `script-src 'unsafe-eval'`).
 *
 * Daemon-side renderer: `apps/agor-daemon/src/services/templates.ts`.
 */

import type { AgorClient, TemplateRenderRequest } from '@agor-live/client';

/**
 * Render a Handlebars template by calling the daemon. Always async.
 *
 * @param client      Connected Feathers client (from `useAgorClient`)
 * @param template    Handlebars template source
 * @param context     Template context
 * @param onError     `'empty'` (default) returns '' on render error;
 *                    `'raw'` returns the unrendered template (good for
 *                    user-facing previews).
 * @returns The rendered string; rejects when the request itself fails.
 */
export async function renderTemplate(
  client: AgorClient,
  template: string,
  context: Record<string, unknown> = {},
  onError: TemplateRenderRequest['onError'] = 'empty'
): Promise<string> {
  if (!template || typeof template !== 'string') return '';
  const result = await client.service('templates').create({ template, context, onError });
  return result.rendered;
}

/**
 * With `onError: 'raw'` the server answers a template it couldn't render with
 * the template itself. A template with an expression that renders to exactly
 * its own source is that fallback.
 */
export function isUnrenderedTemplate(template: string, rendered: string): boolean {
  return rendered === template && template.includes('{{');
}
