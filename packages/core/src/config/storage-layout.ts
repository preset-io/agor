const STORAGE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function requireStorageSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('\0')
  ) {
    throw new Error(`${label} must be a safe storage path segment`);
  }
  return normalized;
}

function requireStorageNamespace(value: string): string {
  const normalized = requireStorageSegment(value, 'Storage namespace');
  if (!STORAGE_SEGMENT_PATTERN.test(normalized)) {
    throw new Error('Storage namespace must be a safe storage path segment');
  }
  return normalized;
}

/**
 * Return Agor-managed path segments below an operator-provided storage base.
 *
 * Storage backends own the base (a local directory, S3 bucket/prefix, etc.);
 * Agor owns everything below it. Keeping this policy backend-neutral prevents
 * local and object-store layouts from drifting as more features use storage.
 */
export function getManagedStorageSegments(
  namespace: string,
  options: { tenantId?: string; tenantSeparated: boolean }
): string[] {
  const safeNamespace = requireStorageNamespace(namespace);
  if (!options.tenantSeparated) return [safeNamespace];

  return ['tenants', requireStorageSegment(options.tenantId ?? '', 'Tenant id'), safeNamespace];
}
