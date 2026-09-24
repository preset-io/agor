import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AgorConfig, UnixUserMode } from '@agor/core/config';
import type { Session } from '@agor/core/types';
import { requireOpenCodeMode, resolveOpenCodeCapabilities } from './capabilities.js';

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
 * durable daemon-local home boundary (the `native-file` credential authority).
 * Any other capability mode fails closed with the resolver's structured reason.
 */
export function assertOpenCodeNativeAuthSupported(
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy' | 'agentic_tools'>
): OpenCodeNativeUnixUserMode {
  return requireOpenCodeMode(
    resolveOpenCodeCapabilities(config),
    ['native-file'],
    'native credential operation'
  ).unixUserMode;
}
