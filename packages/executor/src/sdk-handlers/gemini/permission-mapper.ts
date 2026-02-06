/**
 * Permission Mode Mapper - Maps native Gemini permission modes to SDK ApprovalMode
 *
 * Since we now use native SDK modes directly, this is a simple 1:1 mapping.
 */

import { Gemini } from '@agor/core/sdk';
import type { GeminiPermissionMode } from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';

/**
 * The default Gemini permission mode, used for fallback.
 * Centralized in @agor/core to ensure consistency across the app.
 */
export const GEMINI_DEFAULT_PERMISSION_MODE = getDefaultPermissionMode(
  'gemini'
) as GeminiPermissionMode;

/**
 * Map Gemini permission mode to SDK ApprovalMode
 *
 * Gemini native modes (from UI/API):
 * - 'default': Prompt for each tool use (ApprovalMode.DEFAULT)
 * - 'autoEdit': Auto-approve file edits only (ApprovalMode.AUTO_EDIT)
 * - 'yolo': Auto-approve all operations (ApprovalMode.YOLO)
 *
 * Generic/legacy modes (cross-agent compatibility):
 * - 'ask': Prompt for each tool use → DEFAULT
 * - 'auto': Auto-approve edits → AUTO_EDIT
 * - 'on-failure': Auto-approve on failure → AUTO_EDIT (closest match)
 * - 'allow-all': Auto-approve all → YOLO
 *
 * For unknown modes, falls back to the centralized default from core.
 *
 * @param permissionMode - Native Gemini permission mode or generic mode
 * @returns Gemini SDK ApprovalMode
 */
export function mapPermissionMode(
  permissionMode: GeminiPermissionMode | string | undefined
): (typeof Gemini.ApprovalMode)[keyof typeof Gemini.ApprovalMode] {
  switch (permissionMode) {
    // Gemini native modes
    case 'default':
      return Gemini.ApprovalMode.DEFAULT;

    case 'autoEdit':
      // Note: AUTO_EDIT may block shell commands in non-interactive mode
      // Consider using 'yolo' if you need shell access
      return Gemini.ApprovalMode.AUTO_EDIT;

    case 'yolo':
      return Gemini.ApprovalMode.YOLO;

    // Generic/legacy modes (cross-agent compatibility)
    case 'ask':
      return Gemini.ApprovalMode.DEFAULT;

    case 'auto':
      return Gemini.ApprovalMode.AUTO_EDIT;

    case 'on-failure':
      // Map to AUTO_EDIT as closest match (prompts on dangerous operations)
      return Gemini.ApprovalMode.AUTO_EDIT;

    case 'allow-all':
      return Gemini.ApprovalMode.YOLO;

    default:
      // Fallback to centralized default for unknown modes
      // This ensures consistency with UI and other parts of the app
      return mapPermissionMode(GEMINI_DEFAULT_PERMISSION_MODE);
  }
}
