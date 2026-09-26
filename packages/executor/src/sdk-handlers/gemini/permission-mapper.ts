import { loadManagedAgenticToolSdk } from '@agor/core/agentic-integrations';
import { getDefaultPermissionMode, type PermissionMode } from '@agor/core/types';
import { mapPermissionMode as mapCorePermissionMode } from '@agor/core/utils/permission-mode-mapper';
import type * as GeminiTypes from '@google/gemini-cli-core';

const Gemini = await loadManagedAgenticToolSdk<typeof GeminiTypes>('gemini');
export const GEMINI_DEFAULT_PERMISSION_MODE = getDefaultPermissionMode('gemini');

export function mapPermissionMode(mode: string | undefined): GeminiTypes.ApprovalMode {
  const mapped = mapCorePermissionMode((mode ?? 'default') as PermissionMode, 'gemini');
  return mapped === 'yolo'
    ? Gemini.ApprovalMode.YOLO
    : mapped === 'autoEdit'
      ? Gemini.ApprovalMode.AUTO_EDIT
      : Gemini.ApprovalMode.DEFAULT;
}
