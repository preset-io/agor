/**
 * Handlebars helper functions for template rendering
 *
 * Shared between frontend and backend for consistent template evaluation.
 * Used in:
 * - Environment config templates (up/down commands)
 * - Zone triggers
 * - Report templates
 * - Any other Handlebars-based templating
 */

import Handlebars from 'handlebars';

/**
 * Register all Handlebars helpers
 *
 * Call this once during application initialization.
 */
export function registerHandlebarsHelpers(): void {
  // ===== Arithmetic Helpers =====

  /**
   * Add two numbers
   * Usage: {{add 6000 PORT_SEED}}
   */
  Handlebars.registerHelper('add', (a: unknown, b: unknown): number => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      console.warn(`⚠️  add helper received non-numeric values: ${a}, ${b}`);
      return 0;
    }
    return numA + numB;
  });

  /**
   * Subtract two numbers
   * Usage: {{sub 6000 PORT_SEED}}
   */
  Handlebars.registerHelper('sub', (a: unknown, b: unknown): number => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      console.warn(`⚠️  sub helper received non-numeric values: ${a}, ${b}`);
      return 0;
    }
    return numA - numB;
  });

  /**
   * Multiply two numbers
   * Usage: {{mul PORT_SEED 10}}
   */
  Handlebars.registerHelper('mul', (a: unknown, b: unknown): number => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      console.warn(`⚠️  mul helper received non-numeric values: ${a}, ${b}`);
      return 0;
    }
    return numA * numB;
  });

  /**
   * Divide two numbers
   * Usage: {{div PORT_SEED 2}}
   */
  Handlebars.registerHelper('div', (a: unknown, b: unknown): number => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      console.warn(`⚠️  div helper received non-numeric values: ${a}, ${b}`);
      return 0;
    }
    if (numB === 0) {
      console.warn(`⚠️  div helper received zero divisor`);
      return 0;
    }
    return numA / numB;
  });

  /**
   * Modulo operation
   * Usage: {{mod PORT_SEED 100}}
   */
  Handlebars.registerHelper('mod', (a: unknown, b: unknown): number => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      console.warn(`⚠️  mod helper received non-numeric values: ${a}, ${b}`);
      return 0;
    }
    if (numB === 0) {
      console.warn(`⚠️  mod helper received zero divisor`);
      return 0;
    }
    return numA % numB;
  });

  // ===== String Helpers =====

  /**
   * Convert string to uppercase
   * Usage: {{uppercase worktree.name}}
   */
  Handlebars.registerHelper('uppercase', (str: unknown): string => {
    return String(str || '').toUpperCase();
  });

  /**
   * Convert string to lowercase
   * Usage: {{lowercase worktree.name}}
   */
  Handlebars.registerHelper('lowercase', (str: unknown): string => {
    return String(str || '').toLowerCase();
  });

  /**
   * Replace characters in string
   * Usage: {{replace worktree.name "-" "_"}}
   */
  Handlebars.registerHelper('replace', (str: unknown, search: string, replace: string): string => {
    return String(str || '')
      .split(search)
      .join(replace);
  });

  // ===== Conditional Helpers =====

  /**
   * Equality check
   * Usage: {{#if (eq status "running")}}...{{/if}}
   */
  Handlebars.registerHelper('eq', (a: unknown, b: unknown): boolean => {
    return a === b;
  });

  /**
   * Inequality check
   * Usage: {{#if (neq status "stopped")}}...{{/if}}
   */
  Handlebars.registerHelper('neq', (a: unknown, b: unknown): boolean => {
    return a !== b;
  });

  /**
   * Greater than
   * Usage: {{#if (gt PORT_SEED 100)}}...{{/if}}
   */
  Handlebars.registerHelper('gt', (a: unknown, b: unknown): boolean => {
    return Number(a) > Number(b);
  });

  /**
   * Less than
   * Usage: {{#if (lt PORT_SEED 100)}}...{{/if}}
   */
  Handlebars.registerHelper('lt', (a: unknown, b: unknown): boolean => {
    return Number(a) < Number(b);
  });

  /**
   * Greater than or equal
   * Usage: {{#if (gte PORT_SEED 100)}}...{{/if}}
   */
  Handlebars.registerHelper('gte', (a: unknown, b: unknown): boolean => {
    return Number(a) >= Number(b);
  });

  /**
   * Less than or equal
   * Usage: {{#if (lte PORT_SEED 100)}}...{{/if}}
   */
  Handlebars.registerHelper('lte', (a: unknown, b: unknown): boolean => {
    return Number(a) <= Number(b);
  });

  // ===== Utility Helpers =====

  /**
   * Default value if variable is undefined/null
   * Usage: {{default PORT_SEED 100}}
   */
  Handlebars.registerHelper('default', (value: unknown, defaultValue: unknown): unknown => {
    return value ?? defaultValue;
  });

  /**
   * JSON stringify for debugging
   * Usage: {{json someObject}}
   */
  Handlebars.registerHelper('json', (obj: unknown): string => {
    return JSON.stringify(obj, null, 2);
  });
}

/**
 * Render a Handlebars template with given context
 *
 * Automatically registers helpers if not already registered.
 * Never throws - returns empty string on error (with console warning).
 *
 * @param templateString - Handlebars template string
 * @param context - Template context variables
 * @returns Rendered string, or empty string if rendering fails
 */
export function renderTemplate(templateString: string, context: Record<string, unknown>): string {
  try {
    const template = Handlebars.compile(templateString);
    return template(context);
  } catch (error) {
    console.error('❌ Handlebars template error:', error);
    console.error('Template:', templateString);
    console.error('Context keys:', Object.keys(context));
    return ''; // Return empty string instead of throwing
  }
}

/**
 * Build standard template context for worktree environments
 *
 * Provides scoped entity references (consistent with zone triggers):
 * - {{worktree.unique_id}} - Auto-assigned unique number (1, 2, 3, ...)
 * - {{worktree.name}} - Worktree name (slug format)
 * - {{worktree.path}} - Absolute path to worktree directory
 * - {{worktree.gid}} - Unix GID of worktree's unix_group (if captured)
 * - {{repo.slug}} - Repository slug
 * - {{custom.*}} - Any custom context from worktree.custom_context
 */
export function buildWorktreeContext(worktree: {
  worktree_unique_id: number;
  name: string;
  path: string;
  repo_slug?: string;
  custom_context?: Record<string, unknown>;
  unix_gid?: number;
}): Record<string, unknown> {
  return {
    // Scoped entities (accessible as {{entity.property}})
    worktree: {
      unique_id: worktree.worktree_unique_id,
      name: worktree.name,
      path: worktree.path,
      gid: worktree.unix_gid,
    },
    repo: {
      slug: worktree.repo_slug || '',
    },
    // User-defined custom context (accessible as {{custom.key}})
    custom: worktree.custom_context || {},
  };
}
