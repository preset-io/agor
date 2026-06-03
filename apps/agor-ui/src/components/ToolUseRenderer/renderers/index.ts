/**
 * Tool Renderer Registry
 *
 * Maps tool names to custom renderer components.
 * When a tool use is rendered, ToolUseRenderer checks this registry
 * and uses the custom component if available.
 *
 * To add a new custom renderer:
 * 1. Create a new component in this directory (e.g., MyToolRenderer.tsx)
 * 2. Add it to this registry with the tool name as the key
 *
 * Example:
 *   import { MyToolRenderer } from './MyToolRenderer';
 *   TOOL_RENDERERS.set('MyTool', MyToolRenderer);
 *
 * For long text output, use the CollapsibleText component:
 *   import { CollapsibleText } from '../../CollapsibleText';
 *
 *   // In your renderer:
 *   <CollapsibleText maxLines={10} code preserveWhitespace>
 *     {longOutputText}
 *   </CollapsibleText>
 *
 * This ensures consistent "show more/less" behavior across all tools.
 * See TEXT_TRUNCATION constants in src/constants/ui.ts for default limits.
 */

import type { DiffEnrichment } from '@agor-live/client';
import type React from 'react';
import { BashRenderer } from './BashRenderer';
import { EditFilesRenderer } from './EditFilesRenderer';
import { EditRenderer } from './EditRenderer';
import { TodoListRenderer } from './TodoListRenderer';
import { WriteRenderer } from './WriteRenderer';

/**
 * Props that all custom tool renderers receive
 */
export interface ToolRendererProps {
  /**
   * Tool use ID (for stable React keys)
   */
  toolUseId: string;

  /**
   * Tool input parameters (from tool_use.input)
   */
  input: Record<string, unknown>;

  /**
   * Optional tool result (if available)
   */
  result?: {
    content: string | unknown[];
    is_error?: boolean;
    /** Executor-enriched diff data (best-effort, may not be present) */
    diff?: DiffEnrichment;
  };
}

/**
 * Type for custom renderer components
 */
export type ToolRenderer = React.FC<ToolRendererProps>;

/**
 * Extract a human-readable error message from a tool result.
 * Handles both string content and array-of-blocks content shapes.
 */
export function extractErrorMessage(result: ToolRendererProps['result']): string | undefined {
  if (!result?.is_error) return undefined;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((b): b is { type: 'text'; text: string } => {
        const block = b as { type: string; text?: string };
        return block.type === 'text';
      })
      .map((b) => b.text)
      .join('\n');
  }
  return undefined;
}

/**
 * Registry of tool name -> custom renderer
 */
export const TOOL_RENDERERS = new Map<string, ToolRenderer>([
  // Claude Code tools
  ['TodoWrite', TodoListRenderer as unknown as ToolRenderer],
  ['Bash', BashRenderer as unknown as ToolRenderer],
  ['Edit', EditRenderer as unknown as ToolRenderer],
  ['Write', WriteRenderer as unknown as ToolRenderer],
  // Codex tools
  ['edit_files', EditFilesRenderer as unknown as ToolRenderer],
]);

/**
 * Get custom renderer for a tool (if available)
 *
 * Note: Uses case-insensitive matching to support different SDK conventions:
 * - Claude Code uses PascalCase (e.g., "Bash")
 * - Codex uses lowercase (e.g., "bash")
 * - Gemini uses various conventions
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
  // Try exact match first
  const exactMatch = TOOL_RENDERERS.get(toolName);
  if (exactMatch) return exactMatch;

  // Try lowercase match (handles snake_case tools like edit_files)
  const lower = toolName.toLowerCase();
  for (const [key, renderer] of TOOL_RENDERERS) {
    if (key.toLowerCase() === lower) return renderer;
  }

  return undefined;
}
