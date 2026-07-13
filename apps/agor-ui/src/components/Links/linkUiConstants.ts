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
} as const;

export const LINK_MOVE_DESTINATION = {
  branch: 'branch',
  session: 'session',
  teammate: 'teammate',
} as const;

export type LinkMoveDestination =
  (typeof LINK_MOVE_DESTINATION)[keyof typeof LINK_MOVE_DESTINATION];

export const LINK_ROUTE = {
  move: (linkId: string) => `${LINK_SERVICE}/${linkId}/move`,
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
  moveToBranch: 'Move to branch',
  moveToSession: 'Move to this session',
  moveToTeammate: 'Move to teammate',
  saveChanges: 'Save changes',
  pin: 'Pin',
  unpin: 'Unpin',
} as const;

export const LINK_ACTION_KEY = {
  default: 'action',
  edit: 'edit',
  delete: 'delete',
  moveToBranch: 'move-to-branch',
  moveToSession: 'move-to-session',
  moveToTeammate: 'move-to-teammate',
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
  managePinnedTooltip: 'Manage links',
} as const;

export const LINK_LIFECYCLE_ERROR = {
  ownerRequired: 'A branch or session owner is required',
  persistenceUnavailable: 'This link cannot be saved from this view',
} as const;

export const LINK_MUTATION_MESSAGE = {
  added: 'Link added',
  updated: 'Link updated',
  deleted: 'Link deleted',
  moved: 'Link moved',
} as const;

export const LINK_MUTATION_FAILURE_PREFIX = {
  pin: 'Failed to update pin',
  add: 'Failed to add link',
  update: 'Failed to update link',
  delete: 'Failed to delete link',
  move: 'Failed to move link',
} as const;

export function formatLinkMutationFailure(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`;
}

export const LINK_MOVE_UNAVAILABLE_REASON = {
  disconnected: 'Link actions are unavailable while disconnected',
  missingTarget: 'This link has no movable target',
  fileLifetime: 'Files cannot move until retention and cleanup rules are defined',
  internalAccess: 'Internal references cannot move without target access checks',
} as const;

export const LINK_BUSY_KEY = {
  create: (ownerScope: LinkOwnerScope) => `create:${ownerScope}`,
} as const;
