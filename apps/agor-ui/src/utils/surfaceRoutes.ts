/**
 * Route classifiers for top-level product surfaces.
 *
 * Keep these small and dependency-free so app boot code can decide which
 * surface runtime/store should start before importing or rendering the heavy
 * route trees. A route surface is not the same thing as a URL entity type:
 * `/kb/*` and `/knowledge/*` are the Knowledge surface, while everything else
 * currently belongs to the Workspace surface.
 */
export function isKnowledgeRoutePath(pathname: string): boolean {
  return /^\/(kb|knowledge)(\/|$)/.test(pathname);
}

export function isWorkspaceRoutePath(pathname: string): boolean {
  return !isKnowledgeRoutePath(pathname);
}
