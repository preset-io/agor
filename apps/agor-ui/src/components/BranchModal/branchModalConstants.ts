export const BRANCH_MODAL_TAB = {
  general: 'general',
  teammate: 'teammate',
  knowledge: 'knowledge',
  links: 'links',
  sessions: 'sessions',
  environment: 'environment',
  files: 'files',
  permissions: 'permissions',
  schedule: 'schedule',
} as const;

export type BranchModalTab = (typeof BRANCH_MODAL_TAB)[keyof typeof BRANCH_MODAL_TAB];
