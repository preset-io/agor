export interface EntityRouteParams {
  sessionShortId?: string;
  branchShortId?: string;
  artifactShortId?: string;
}

/**
 * Entity routes carry an explicit user target. Generic board/root restore
 * behavior must not override them while URL→state resolution catches up.
 */
export function hasExplicitEntityRouteTarget(params: EntityRouteParams): boolean {
  return Boolean(params.sessionShortId || params.branchShortId || params.artifactShortId);
}
