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
// `RenderTemplateOnError` lives in core/types so the browser-facing client
// types don't transitively pull in this Handlebars-coupled module. We
// re-export below for back-compat with callers already importing it here.
import type { RenderTemplateOnError } from '../types/template';

/**
 * Track whether helpers have been registered on this Handlebars instance.
 *
 * In bundled environments (e.g. tsup-bundled `@agor-live/client`), the
 * `Handlebars` instance imported here is closure-captured at build time and
 * is NOT the same instance the host app may import. That means a host-app
 * call to `registerHandlebarsHelpers()` registers against a *different*
 * instance from the one `renderTemplate()` ultimately compiles against,
 * producing the silent failure mode where templates using any helper
 * (`{{add}}`, `{{eq}}`, `{{uppercase}}`, …) compile but throw at render time
 * — which `renderTemplate` then swallows into an empty string.
 *
 * To make `renderTemplate` self-sufficient, we lazily register helpers on
 * first use against the same instance the function compiles against.
 */
let helpersRegistered = false;

/**
 * Register all Handlebars helpers
 *
 * Idempotent — safe to call multiple times. `renderTemplate()` calls this
 * automatically on first use, so explicit invocation is only needed when
 * the caller wants to use the bare `Handlebars.compile()` API.
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
   * Usage: {{uppercase branch.name}}
   */
  Handlebars.registerHelper('uppercase', (str: unknown): string => {
    return String(str || '').toUpperCase();
  });

  /**
   * Convert string to lowercase
   * Usage: {{lowercase branch.name}}
   */
  Handlebars.registerHelper('lowercase', (str: unknown): string => {
    return String(str || '').toLowerCase();
  });

  /**
   * Replace characters in string
   * Usage: {{replace branch.name "-" "_"}}
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

  /**
   * True when the value is defined (i.e. not `undefined`). Distinguishes
   * "explicitly false" from "absent" in `{{#if}}` blocks — used by the
   * spawn-subsession template to render boolean callback flags only when
   * the caller actually set them.
   * Usage: {{#if (isDefined callbackConfig.enableCallback)}}...{{/if}}
   */
  Handlebars.registerHelper('isDefined', (value: unknown): boolean => value !== undefined);

  helpersRegistered = true;
}

/**
 * Re-export `RenderTemplateOnError` for back-compat. Canonical definition
 * lives in `../types/template.ts`.
 */
export type { RenderTemplateOnError } from '../types/template';

export interface RenderTemplateOptions {
  /** Behavior when rendering throws. Default: `'empty'`. */
  onError?: RenderTemplateOnError;
}

/**
 * Render a Handlebars template with given context
 *
 * Automatically registers helpers on the same Handlebars instance this
 * function compiles against — see the `helpersRegistered` doc above for
 * why caller-side registration is not enough in bundled environments.
 *
 * Never throws. On error, returns `''` by default (safe for command/env/
 * prompt composition); pass `{ onError: 'raw' }` to surface the raw
 * template string instead (preferred for user-facing previews). Empty/
 * non-string input always returns `''`.
 *
 * @param templateString - Handlebars template string
 * @param context - Template context variables
 * @param options - Render options (see `RenderTemplateOptions`)
 * @returns Rendered string, or the configured fallback on failure
 */
export function renderTemplate(
  templateString: string,
  context: Record<string, unknown>,
  options: RenderTemplateOptions = {}
): string {
  if (!templateString || typeof templateString !== 'string') {
    return '';
  }
  if (!helpersRegistered) {
    registerHandlebarsHelpers();
  }
  try {
    const template = Handlebars.compile(templateString);
    return template(context);
  } catch (error) {
    console.error('❌ Handlebars template error:', error);
    console.error('Template:', templateString);
    console.error('Context keys:', Object.keys(context));
    if (options.onError === 'raw') {
      // Return the raw template so the user sees *something* (the unrendered
      // placeholders) rather than a silently-blank result. Used by UI
      // previews where a silent blank textarea hides the bug.
      return templateString;
    }
    return '';
  }
}

/**
 * Build standard template context for branch environments
 *
 * Provides scoped entity references (consistent with zone triggers):
 * - {{branch.unique_id}} - Auto-assigned unique number (1, 2, 3, ...)
 * - {{branch.name}} - Branch name (slug format)
 * - {{branch.path}} - Absolute path to branch directory
 * - {{branch.gid}} - Unix GID of branch's unix_group (resolved dynamically at execution time)
 * - {{branch.base_ref}} - Source branch/tag name this branch was created from
 *   (the "Base Branch"/"Base Tag" from the create dialog). Empty string if unknown.
 * - {{branch.ref_type}} - 'branch' | 'tag': whether base_ref names a branch or a tag
 * - {{repo.slug}} - Repository slug
 * - {{host.ip_address}} - Primary non-loopback IPv4 of the daemon host
 *   (for health checks/URLs that must reach the host from inside a container).
 *   Frozen at branch creation time. Empty string if not resolved.
 * - {{custom.*}} - Any custom context from branch.custom_context
 *
 * Backwards-compat: also exposes the same scoped entity under `{{worktree.*}}`
 * so existing `.agor.yml` env-template configurations using the v0.19 names
 * (`{{worktree.unique_id}}`, `{{worktree.name}}`, etc.) continue to render.
 * New configs should use `{{branch.*}}`. The legacy alias may be removed in
 * a future major release.
 */
export function buildBranchContext(branch: {
  branch_unique_id: number;
  name: string;
  path: string;
  repo_slug?: string;
  custom_context?: Record<string, unknown>;
  unix_gid?: number;
  host_ip_address?: string;
  base_ref?: string;
  ref_type?: 'branch' | 'tag';
}): Record<string, unknown> {
  const branchEntity = {
    unique_id: branch.branch_unique_id,
    name: branch.name,
    path: branch.path,
    gid: branch.unix_gid,
    base_ref: branch.base_ref || '',
    ref_type: branch.ref_type || 'branch',
  };
  return {
    // Scoped entities (accessible as {{entity.property}})
    branch: branchEntity,
    // Legacy alias — preserved for existing env templates that reference
    // {{worktree.*}} keys. Points at the same object so updates stay in sync.
    worktree: branchEntity,
    repo: {
      slug: branch.repo_slug || '',
    },
    host: {
      ip_address: branch.host_ip_address || '',
    },
    // User-defined custom context (accessible as {{custom.key}})
    custom: branch.custom_context || {},
  };
}
