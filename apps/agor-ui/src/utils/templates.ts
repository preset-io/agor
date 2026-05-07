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
 * @returns The rendered string, or `''` on transport failure.
 */
export async function renderTemplate(
  client: AgorClient,
  template: string,
  context: Record<string, unknown> = {},
  onError: TemplateRenderRequest['onError'] = 'empty'
): Promise<string> {
  if (!template || typeof template !== 'string') return '';
  try {
    const result = await client.service('templates').create({ template, context, onError });
    return result.rendered;
  } catch (err) {
    console.error('Template render failed:', err);
    return onError === 'raw' ? template : '';
  }
}
