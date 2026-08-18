import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AgorConfig, UnixUserMode } from '@agor/core/config';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import type { Session } from '@agor/core/types';

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
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>
): OpenCodeNativeUnixUserMode {
  if (resolveMultiTenancyConfig(config).mode === 'required_from_auth') {
    throw new BadRequest(
      'OpenCode provider connection and execution are unavailable in hosted multi-tenant mode.'
    );
  }

  const mode = config.execution?.unix_user_mode ?? 'simple';
  if (mode === 'delegated') {
    throw new BadRequest(
      'OpenCode provider connection and execution are unavailable in delegated execution mode because the execution substrate does not provide a native-state home boundary.'
    );
  }
  return mode;
}
