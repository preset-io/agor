/**
 * Frontend Handlebars helpers
 *
 * Re-exports the shared helpers from @agor/core and provides
 * initialization for the frontend app.
 */

import { registerHandlebarsHelpers } from '@agor-live/client';

// Re-export shared handlebars helpers
export {
  buildWorktreeContext,
  registerHandlebarsHelpers,
  renderTemplate,
} from '@agor-live/client';

/**
 * Initialize Handlebars helpers for frontend
 *
 * Call this once during app initialization (e.g., in main.tsx)
 */
export function initializeHandlebarsHelpers(): void {
  registerHandlebarsHelpers();
}
