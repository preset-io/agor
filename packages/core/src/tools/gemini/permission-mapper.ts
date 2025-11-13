/**
 * Permission Mode Mapper - Pure utility for mapping Agor permission modes to Gemini ApprovalMode
 */

import { ApprovalMode } from '@google/gemini-cli-core';
import type { PermissionMode } from '../../types';

/**
 * Map Agor permission mode to Gemini ApprovalMode
 *
 * Agor permission modes:
 * - 'default' | 'ask': Prompt for each tool use (most restrictive)
 * - 'acceptEdits' | 'auto': Auto-accept file edits, ask for other tools (recommended)
 * - 'bypassPermissions' | 'allow-all': Allow all operations without prompting
 * - 'plan': Plan mode (not applicable to Gemini, uses default)
 * - 'on-failure': Codex-specific mode (not applicable to Gemini, uses default)
 *
 * Gemini ApprovalMode:
 * - DEFAULT: Prompt for each tool use
 * - AUTO_EDIT: Auto-approve file edits only (currently disabled - see note below)
 * - YOLO: Auto-approve all operations
 *
 * @param permissionMode - Agor permission mode
 * @returns Gemini ApprovalMode
 */
export function mapPermissionMode(permissionMode: PermissionMode): ApprovalMode {
  switch (permissionMode) {
    case 'default':
    case 'ask':
      return ApprovalMode.DEFAULT; // Prompt for each tool use

    case 'acceptEdits':
    case 'auto':
      // TEMPORARY: Map to YOLO since AUTO_EDIT blocks shell commands in non-interactive mode
      // TODO: Implement proper approval handling for AUTO_EDIT mode
      return ApprovalMode.YOLO; // Auto-approve all operations (was: AUTO_EDIT)

    case 'bypassPermissions':
    case 'allow-all':
      return ApprovalMode.YOLO; // Auto-approve all operations

    default:
      return ApprovalMode.DEFAULT;
  }
}
