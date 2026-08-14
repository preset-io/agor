/** Commands whose daemon RPC access is carried by an executor service JWT. */
export const EXECUTOR_SERVICE_COMMANDS = [
  'git.clone',
  'git.branch.add',
  'git.branch.remove',
  'git.repo.delete',
  'git.repo.realign-origin',
  'git.managed-credentials.reconcile',
  'branch.files.list',
  'branch.files.browse',
  'branch.files.read',
  'branch.filesystem.status',
  'branch.artifact.publish',
  'branch.artifact.land',
  'branch.artifact.validate',
  'branch.knowledge.write',
  'branch.knowledge.read',
  'branch.gateway.slack-file-upload',
  'branch.upload.materialize',
  'branch.agor-yml.import',
  'branch.agor-yml.export',
  'unix.sync-branch',
  'unix.sync-board',
  'unix.sync-repo',
  'unix.sync-user',
] as const;

export type ExecutorServiceCommand = (typeof EXECUTOR_SERVICE_COMMANDS)[number];

/** Authenticated, command-scoped daemon capability presented by an executor. */
export interface ExecutorServiceTokenPayload {
  type: 'service';
  sub: 'executor-service';
  purpose: 'executor-service';
  role: 'service';
  command: ExecutorServiceCommand;
  branch_id?: string;
  branch_ids?: string[];
  repo_id?: string;
  user_id?: string;
  board_id?: string;
  artifact_id?: string;
  filesystem_operation_id?: string;
  executor_action?: string;
}

export function isExecutorServiceTokenPayload(
  value: unknown
): value is ExecutorServiceTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<ExecutorServiceTokenPayload>;
  return (
    payload.type === 'service' &&
    payload.sub === 'executor-service' &&
    payload.purpose === 'executor-service' &&
    payload.role === 'service' &&
    typeof payload.command === 'string' &&
    (EXECUTOR_SERVICE_COMMANDS as readonly string[]).includes(payload.command)
  );
}
