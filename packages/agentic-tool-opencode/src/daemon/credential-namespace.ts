import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { UnixUserMode } from '@agor/core/config';
import type { Session } from '@agor/core/types';
import { type OpenCodeCapabilityConfig, requireOpenCodeSupported } from './capabilities.js';

const SUBJECT_KEY_VERSION = 'agor-opencode-v1';

export type OpenCodeNativeUnixUserMode = Exclude<UnixUserMode, 'delegated'>;

export type OpenCodeCredentialNamespace = {
  namespaceKey: string;
  dataHome: string;
};

export function resolveOpenCodeCredentialNamespace(input: {
  tenantId: string;
  subjectUserId: string;
  homeDir: string;
}): OpenCodeCredentialNamespace {
  const tenantId = input.tenantId.trim();
  const subjectUserId = input.subjectUserId.trim();
  if (!tenantId || !subjectUserId) {
    throw new Error('OpenCode credential routing requires tenant and user identity');
  }
  if (!isAbsolute(input.homeDir)) {
    throw new Error('OpenCode credential routing requires an absolute executor home');
  }

  const homeDir = resolve(input.homeDir);
  const namespaceKey = createHash('sha256')
    .update(JSON.stringify([SUBJECT_KEY_VERSION, tenantId, subjectUserId]))
    .digest('hex');
  const root = join(homeDir, '.local', 'share', 'agor', 'opencode');
  const dataHome = join(root, namespaceKey);
  const child = relative(root, dataHome);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error('OpenCode credential namespace escaped its executor home');
  }
  return { namespaceKey, dataHome };
}

export function resolveOpenCodeTaskCredentialNamespace(input: {
  tenantId: string;
  session: Pick<Session, 'created_by' | 'unix_username'>;
  homeDir: string;
}): OpenCodeCredentialNamespace {
  return resolveOpenCodeCredentialNamespace({
    tenantId: input.tenantId,
    subjectUserId: input.session.created_by,
    homeDir: input.homeDir,
  });
}

/**
 * Resolve the Unix mode only after proving that native OpenCode state has a
 * durable home boundary in the current execution topology.
 */
export function assertOpenCodeNativeAuthSupported(
  config: OpenCodeCapabilityConfig
): OpenCodeNativeUnixUserMode {
  return requireOpenCodeSupported(config).unixUserMode;
}
