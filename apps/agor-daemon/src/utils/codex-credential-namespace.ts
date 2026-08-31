import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { UnixUserMode } from '@agor/core/config';
import type { Session } from '@agor/core/types';

const SUBJECT_KEY_VERSION = 'agor-codex-v1';

/**
 * Resolve the Codex home used by one Agor user in trusted local simple mode.
 *
 * This is a credential/state namespace, not an OS security boundary: every
 * simple-mode executor still runs as the daemon uid. Including the trusted
 * tenant identity prevents two tenants with the same user id from sharing the
 * same native Codex state if a local deployment is later imported or merged.
 */
export function resolveSimpleCodexHome(input: {
  tenantId: string;
  subjectUserId: string;
  homeDir: string;
}): string {
  const tenantId = input.tenantId.trim();
  const subjectUserId = input.subjectUserId.trim();
  if (!tenantId || !subjectUserId) {
    throw new Error('Simple-mode Codex credential routing requires tenant and user identity');
  }
  if (!isAbsolute(input.homeDir)) {
    throw new Error('Simple-mode Codex credential routing requires an absolute executor home');
  }

  const homeDir = resolve(input.homeDir);
  const namespaceKey = createHash('sha256')
    .update(JSON.stringify([SUBJECT_KEY_VERSION, tenantId, subjectUserId]))
    .digest('hex');
  const root = join(homeDir, '.local', 'share', 'agor', 'codex');
  const codexHome = join(root, namespaceKey);
  const child = relative(root, codexHome);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error('Simple-mode Codex credential namespace escaped its executor home');
  }
  return codexHome;
}

export interface SimpleCodexTaskHomeInput {
  mode: UnixUserMode;
  executorCommandTemplate?: string;
  tenantId: string | undefined;
  session: Pick<Session, 'agentic_tool' | 'created_by'>;
  homeDir: string;
}

/** Resolve the authoritative native-state home for a Codex task, if simple mode owns it. */
export function resolveSimpleCodexTaskHome(input: SimpleCodexTaskHomeInput): string | undefined {
  if (
    input.mode !== 'simple' ||
    input.executorCommandTemplate ||
    input.session.agentic_tool !== 'codex'
  ) {
    return undefined;
  }
  if (!input.tenantId) throw new Error('Missing active tenant context for Codex execution');
  if (!input.session.created_by) throw new Error('Missing session owner for Codex execution');
  return resolveSimpleCodexHome({
    tenantId: input.tenantId,
    subjectUserId: input.session.created_by,
    homeDir: input.homeDir,
  });
}

/**
 * Apply the daemon-authorized simple-mode Codex home after user env resolution.
 *
 * The assignment deliberately overwrites a user-managed `CODEX_HOME`. Other
 * modes and templated simple executors are untouched because their execution
 * substrate owns native-state routing.
 */
export function applySimpleCodexTaskHome(
  executorEnv: Record<string, string>,
  input: SimpleCodexTaskHomeInput
): string | undefined {
  const codexHome = resolveSimpleCodexTaskHome(input);
  if (codexHome) executorEnv.CODEX_HOME = codexHome;
  return codexHome;
}
