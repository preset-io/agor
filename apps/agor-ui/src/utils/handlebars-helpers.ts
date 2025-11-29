/**
 * Frontend Handlebars helpers
 *
 * Re-exports the shared helpers from @agor/core and provides
 * initialization for the frontend app.
 */

import { registerHandlebarsHelpers } from '@agor/core/templates/handlebars-helpers';

// Export everything from core
export * from '@agor/core/templates/handlebars-helpers';

/**
 * Initialize Handlebars helpers for frontend
 *
 * Call this once during app initialization (e.g., in main.tsx)
 */
export function initializeHandlebarsHelpers(): void {
  registerHandlebarsHelpers();
}
