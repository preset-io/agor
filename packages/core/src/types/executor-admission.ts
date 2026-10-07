import { BRANCH_ARCHIVE_COMMAND, BRANCH_CLEANUP_COMMAND } from './branch-cleanup';
import { BRANCH_DELETION_COMMAND } from './branch-deletion';

/**
 * Admission class of an executor run. A launcher that gates concurrency (Agor
 * Cloud) counts `agent` runs against the agent limit; `utility` runs count only
 * against the executor ceiling. Cross-repo contract: preset-io/agor-cloud#814.
 */
export const EXECUTOR_ADMISSION_CLASSES = ['agent', 'utility'] as const;
export type ExecutorAdmissionClass = (typeof EXECUTOR_ADMISSION_CLASSES)[number];

/**
 * The class of every registered executor command. The executor registry only
 * accepts names from this map, so a new command cannot ship without a class.
 */
export const EXECUTOR_COMMAND_ADMISSION = {
  prompt: 'agent',
  'agentic-tool.invoke': 'agent',
  'zellij.attach': 'agent',
  'zellij.tab': 'agent',
  'git.clone': 'utility',
  'git.branch.add': 'utility',
  'git.branch.remove': 'utility',
  'git.branch.clean': 'utility',
  'git.repo.realign-origin': 'utility',
  'git.repo.delete': 'utility',
  'git.repo.inspect': 'utility',
  'git.managed-credentials.reconcile': 'utility',
  [BRANCH_DELETION_COMMAND]: 'utility',
  [BRANCH_CLEANUP_COMMAND]: 'utility',
  [BRANCH_ARCHIVE_COMMAND]: 'utility',
  'branch.files.list': 'utility',
  'branch.files.browse': 'utility',
  'branch.files.read': 'utility',
  'branch.filesystem.status': 'utility',
  'branch.artifact.publish': 'utility',
  'branch.artifact.land': 'utility',
  'branch.artifact.validate': 'utility',
  'branch.knowledge.write': 'utility',
  'branch.knowledge.read': 'utility',
  'branch.gateway.slack-file-upload': 'utility',
  'branch.upload.materialize': 'utility',
  'branch.agor-yml.import': 'utility',
  'branch.agor-yml.export': 'utility',
  'environment.lifecycle': 'utility',
  'environment.logs': 'utility',
  'codex.auth-file': 'utility',
  'claude.auth-file': 'utility',
} as const satisfies Record<string, ExecutorAdmissionClass>;

export type ExecutorCommandName = keyof typeof EXECUTOR_COMMAND_ADMISSION;

/** The mapped class, or `agent` for anything missing or unknown (fail closed). */
export function executorAdmissionClassFor(command: unknown): ExecutorAdmissionClass {
  if (typeof command !== 'string' || !Object.hasOwn(EXECUTOR_COMMAND_ADMISSION, command)) {
    return 'agent';
  }
  return EXECUTOR_COMMAND_ADMISSION[command as ExecutorCommandName];
}
