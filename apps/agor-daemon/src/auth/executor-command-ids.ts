/**
 * Canonical identities for taskless executor commands whose bearer also
 * authorizes one raw HTTP data-plane callback.
 *
 * Components are encoded before joining so equality remains unambiguous even
 * if an upstream provider broadens an identifier alphabet later.
 */
function component(value: string): string {
  return encodeURIComponent(value);
}

export function uploadMaterializeExecutorCommandId(sessionId: string, uploadRef: string): string {
  return `upload.materialize:${component(sessionId)}:${component(uploadRef)}`;
}

export function gatewaySlackUploadExecutorCommandId(
  gatewayChannelId: string,
  slackChannelId: string
): string {
  return `gateway.slack-file-upload:${component(gatewayChannelId)}:${component(slackChannelId)}`;
}

export function gitBranchAddExecutorCommandId(attemptId: string): string {
  return `git.branch.add:${component(attemptId)}`;
}

export function gitCloneExecutorCommandId(repoId: string): string {
  return `git.clone:${component(repoId)}`;
}

export function parseGitCloneExecutorCommandId(commandId: string): string | null {
  const match = /^git\.clone:([^:]+)$/.exec(commandId);
  if (!match) return null;
  try {
    const repoId = decodeURIComponent(match[1]);
    return repoId.length > 0 ? repoId : null;
  } catch {
    return null;
  }
}

export function parseGitBranchAddExecutorCommandId(commandId: string): string | null {
  const match = /^git\.branch\.add:([^:]+)$/.exec(commandId);
  if (!match) return null;
  try {
    const attemptId = decodeURIComponent(match[1]);
    return attemptId.length > 0 ? attemptId : null;
  } catch {
    return null;
  }
}

export type EnvironmentLifecycleExecutorAction = 'start' | 'stop' | 'nuke';

export function environmentLifecycleExecutorCommandId(
  action: EnvironmentLifecycleExecutorAction,
  generation: number
): string {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Environment lifecycle generation must be a non-negative integer');
  }
  return `environment-${action}:${generation}`;
}

export function parseEnvironmentLifecycleExecutorCommandId(
  commandId: string
): { action: EnvironmentLifecycleExecutorAction; generation: number } | null {
  const match = /^environment-(start|stop|nuke):(\d+)$/.exec(commandId);
  if (!match) return null;
  const generation = Number(match[2]);
  if (!Number.isSafeInteger(generation)) return null;
  return {
    action: match[1] as EnvironmentLifecycleExecutorAction,
    generation,
  };
}
