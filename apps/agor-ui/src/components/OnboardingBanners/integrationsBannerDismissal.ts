/**
 * Persistent, per-user dismissal of the teal "Connect tools via MCP" banner.
 * "Maybe later" should stay dismissed across reloads, so the choice lives in
 * localStorage rather than component state.
 */
interface StoredDismissal {
  version: 1;
  dismissed: true;
}

export function integrationsBannerDismissalKey(userId: string): string {
  return `agor:integrations-banner:v1:${userId}`;
}

export function readIntegrationsBannerDismissed(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  userId: string
): boolean {
  const key = integrationsBannerDismissalKey(userId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<StoredDismissal>;
    if (parsed.version !== 1 || parsed.dismissed !== true) {
      storage.removeItem(key);
      return false;
    }
    return true;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Best effort only.
    }
    return false;
  }
}

export function writeIntegrationsBannerDismissed(
  storage: Pick<Storage, 'setItem'>,
  userId: string
): void {
  try {
    storage.setItem(
      integrationsBannerDismissalKey(userId),
      JSON.stringify({ version: 1, dismissed: true } satisfies StoredDismissal)
    );
  } catch {
    // Best effort: the in-memory dismissal still hides it this session.
  }
}
