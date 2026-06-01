// Module-level snapshot of context the global ErrorBoundary wants to include
// in crash reports (build SHA, signed-in user, etc.). Populated as a side
// effect from <AppContent> via useEffect; read synchronously by the boundary
// when a render crashes. We can't use hooks from a class component, and
// React context is unavailable above the crash point — so a plain module
// singleton is the simplest path.

export interface CrashContext {
  buildSha: string | null;
  userEmail: string | null;
}

let current: CrashContext = {
  buildSha: null,
  userEmail: null,
};

export function setCrashContext(patch: Partial<CrashContext>): void {
  current = { ...current, ...patch };
}

export function getCrashContext(): CrashContext {
  return current;
}
