import type { MCPTransport } from '@agor-live/client';
import { useCallback, useState } from 'react';

/**
 * The fields an MCP server form cannot be submitted without, and the wording
 * used to say so.
 *
 * `Start OAuth Flow` persists the server row before it redirects — the daemon
 * binds the attempt (and the token it returns) to an `mcp_server_id`. So the
 * OAuth button is gated on everything a *write* needs, not just on the URL it
 * sends. Keeping that list here means the button, the modal's save action, and
 * the `Form.Item` rules all name the same fields.
 */

export type MCPAuthType = 'none' | 'bearer' | 'jwt' | 'oauth';

/** Keyed by form field; the label is the one rendered above the input. */
const REQUIRED_FIELD_LABELS = {
  name: 'Name (Internal ID)',
  command: 'Command',
  url: 'URL',
  auth_token: 'Token',
  jwt_api_url: 'API URL',
  jwt_api_token: 'API Token',
  jwt_api_secret: 'API Secret',
} as const;

export type MCPRequiredField = keyof typeof REQUIRED_FIELD_LABELS;

export interface MCPRequirementContext {
  mode: 'create' | 'edit';
  transport?: MCPTransport;
  authType?: MCPAuthType;
}

/** Which fields are required for the combination currently on screen. */
export function requiredMCPFields({
  mode,
  transport,
  authType,
}: MCPRequirementContext): MCPRequiredField[] {
  const fields: MCPRequiredField[] = [];

  // The internal ID is write-once — the edit form renders it disabled, so an
  // existing server can never be missing one.
  if (mode === 'create') fields.push('name');

  if (transport === 'stdio') {
    fields.push('command');
    // Auth is configured for remote transports only.
    return fields;
  }

  fields.push('url');
  // CREATE must be immediately configured. EDIT deliberately permits an
  // explicit secret clear: the saved row remains editable and the session/UI
  // status moves to needs-auth until replacement credentials are supplied.
  if (authType === 'bearer' && mode === 'create') fields.push('auth_token');
  if (authType === 'jwt') {
    fields.push('jwt_api_url');
    if (mode === 'create') fields.push('jwt_api_token', 'jwt_api_secret');
  }
  return fields;
}

function isFilled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

/**
 * The labels of the required fields that are still blank. Empty means the form
 * has enough to attempt a write — the daemon and the per-field rules still get
 * the last word on whether the values are any good.
 */
export function missingMCPFieldLabels(
  values: Record<string, unknown>,
  context: MCPRequirementContext
): string[] {
  return requiredMCPFields(context)
    .filter((field) => !isFilled(values[field]))
    .map((field) => REQUIRED_FIELD_LABELS[field]);
}

/**
 * A counter to re-render on whenever the form's values move, so a caller can
 * read `form.getFieldsValue(true)` during render and trust it.
 *
 * `Form.useWatch` is the obvious tool here and the wrong one: it delivers
 * changes on a macrotask, so a button gated on it lags the keystroke that
 * unblocked it. Bump this from the form's `onValuesChange` (and after
 * programmatic `setFieldsValue`, which does not fire that) and the gate moves
 * in the same commit as the edit.
 */
export function useFormRevision(): [number, () => void] {
  const [revision, setRevision] = useState(0);
  return [revision, useCallback(() => setRevision((current) => current + 1), [])];
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** Tooltip for a disabled save/create action. */
export function describeMissingForSave(labels: string[]): string {
  return `Fill in ${joinLabels(labels)} to save this server.`;
}

/** Tooltip for a disabled `Start OAuth Flow`, which saves before it redirects. */
export function describeMissingForOAuth(labels: string[]): string {
  return `Starting OAuth saves this server first — fill in ${joinLabels(labels)}.`;
}

/**
 * The first field-level complaint from a rejected `validateFields()`, so a
 * caller can say which field it was instead of "failed to save". Returns null
 * for anything that isn't an AntD validation rejection.
 */
export function firstFormErrorMessage(error: unknown): string | null {
  const errorFields = (error as { errorFields?: Array<{ errors?: string[] }> } | null)?.errorFields;
  if (!Array.isArray(errorFields)) return null;
  for (const field of errorFields) {
    const message = field?.errors?.find((entry) => typeof entry === 'string' && entry.length > 0);
    if (message) return message;
  }
  return null;
}
