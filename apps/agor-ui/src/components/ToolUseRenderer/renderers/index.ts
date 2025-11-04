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

import type React from 'react';
import { TodoListRenderer } from './TodoListRenderer';

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
  };
}

/**
 * Type for custom renderer components
 */
export type ToolRenderer = React.FC<ToolRendererProps>;

/**
 * Registry of tool name -> custom renderer
 */
export const TOOL_RENDERERS = new Map<string, ToolRenderer>([
  // Claude Code tools
  ['TodoWrite', TodoListRenderer as unknown as ToolRenderer],

  // Add more custom renderers here:
  // ['Bash', BashRenderer],
  // ['Read', FileReadRenderer],
  // ['Edit', FileEditRenderer],
  // etc.
]);

/**
 * Get custom renderer for a tool (if available)
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
  return TOOL_RENDERERS.get(toolName);
}
