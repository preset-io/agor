export const LINK_OWNER_SCOPE = {
  branch: 'branch',
  session: 'session',
} as const;

export type LinkOwnerScope = (typeof LINK_OWNER_SCOPE)[keyof typeof LINK_OWNER_SCOPE];

export const LINK_SERVICE = 'links';

export const LINK_KIND = {
  issue: 'issue',
  pullRequest: 'pr',
  knowledge: 'kb_ref',
  internal: 'internal',
  url: 'url',
} as const;

export const LINK_SOURCE = {
  manual: 'manual',
  upload: 'upload',
} as const;

export const LINK_TARGET = {
  knowledgePrefix: 'agor://kb/',
  httpProtocol: 'http:',
  httpsProtocol: 'https:',
  githubHost: 'github.com',
  fileKeyPrefix: 'file:',
  urlKeyPrefix: 'url:',
  refKeyPrefix: 'ref:',
} as const;

export const LINK_PROMOTION_TARGET = {
  teammate: 'teammate',
} as const;

export const LINK_PROMOTION_REASON = {
  noTeammate: 'no-teammate',
  sameOwner: 'same-owner',
  existingTarget: 'existing-target',
  missingTarget: 'missing-target',
  fileLifetime: 'file-target-lifetime',
  internalAccess: 'internal-target-access',
} as const;

export type LinkPromotionReason =
  (typeof LINK_PROMOTION_REASON)[keyof typeof LINK_PROMOTION_REASON];

export const LINK_ROUTE = {
  promote: (linkId: string) => `${LINK_SERVICE}/${linkId}/promote`,
} as const;

export const LINK_FORM_FIELD = {
  title: 'title',
  target: 'target',
  isPinned: 'isPinned',
} as const;

export const LINK_FORM_LIMIT = {
  titleLength: 200,
} as const;

export const LINK_ACTION_LABEL = {
  add: 'Add link',
  edit: 'Edit link',
  delete: 'Delete link',
  saveToBranch: 'Save to branch',
  saveToTeammate: 'Save to teammate',
  removeFromTeammate: 'Remove from teammate',
  saveChanges: 'Save changes',
  pin: 'Pin',
  unpin: 'Unpin',
  promotionUnavailable: 'Cannot save this link to a teammate',
} as const;

export const LINK_ACTION_KEY = {
  default: 'action',
  edit: 'edit',
  delete: 'delete',
  saveToBranch: 'save-to-branch',
  saveToTeammate: 'save-to-teammate',
  removeFromTeammate: 'remove-from-teammate',
} as const;

export function getLinkActionsAriaLabel(name: string): string {
  return `Actions for ${name}`;
}

export const LINK_CONFIRM_COPY = {
  deleteTitle: 'Delete link?',
  deleteContent: 'This removes the saved link. It does not change the original message or target.',
  deleteOk: 'Delete',
  cancel: 'Cancel',
} as const;

export const LINK_FORM_COPY = {
  label: 'Label',
  labelPlaceholder: 'Optional display label',
  target: 'Target',
  targetPlaceholder: 'https://example.com or agor://kb/team/document.md',
  targetRequired: 'Enter a link target',
  targetFormat: 'Enter an http:// or https:// URL, or an agor://kb/ reference',
  targetProtocol: 'Only http:// and https:// links are supported',
  targetReadOnly: 'This target comes from its source. You can still change the display label.',
  pinInContext: 'Pin in context',
} as const;

export const LINK_MANAGER_COPY = {
  title: 'Manage links',
  pinnedTitle: 'Pinned links',
  actionsTooltip: 'Link actions',
} as const;

export const LINK_LIFECYCLE_ERROR = {
  ownerRequired: 'A branch or session owner is required',
  persistenceUnavailable: 'This link cannot be saved from this view',
  branchSaveTarget: 'Only web and knowledge links can be saved to a branch',
} as const;

export const LINK_MUTATION_MESSAGE = {
  added: 'Link added',
  updated: 'Link updated',
  deleted: 'Link deleted',
  savedToBranch: 'Saved to branch',
  savedToTeammate: 'Saved to teammate',
  alreadyOnTeammate: 'Already available on teammate',
  removedFromTeammate: 'Removed from teammate',
  invalidTeammateRemoval: 'Only links created by teammate promotion can be removed',
} as const;

export const LINK_MUTATION_FAILURE_PREFIX = {
  pin: 'Failed to update pin',
  add: 'Failed to add link',
  update: 'Failed to update link',
  delete: 'Failed to delete link',
  save: 'Failed to save link',
  saveToTeammate: 'Failed to save link to teammate',
  removeFromTeammate: 'Failed to remove teammate link',
} as const;

export function formatLinkMutationFailure(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`;
}

export const LINK_UNAVAILABLE_REASON = {
  disconnected: 'Link actions are unavailable while disconnected',
  noTeammate: 'No teammate configured',
  sameOwner: 'Already saved to this teammate',
  existingTarget: 'Already saved to teammate',
  missingTarget: 'This link has no reusable target',
  fileLifetime: 'Files cannot be saved until retention and cleanup rules are defined',
  internalAccess: 'Internal references cannot be saved without target access checks',
  branchOwned: 'Already saved to branch',
} as const;

export const LINK_BUSY_KEY = {
  create: (ownerScope: LinkOwnerScope) => `create:${ownerScope}`,
} as const;
