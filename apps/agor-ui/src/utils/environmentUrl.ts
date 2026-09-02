import { resolveEnvironmentHealthTarget } from '@agor/core/environment/lifecycle-result';
import type { Branch } from '@agor-live/client';

function safeHttpUrl(value: string | undefined, allowQueryAndFragment = false): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      (!allowQueryAndFragment && (parsed.search || parsed.hash))
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/** Runtime result order is canonical: the first safe URL is the primary application. */
export function getEnvironmentAccessUrls(branch: Branch): Array<{ name: string; url: string }> {
  const seen = new Set<string>();
  const runtime = (branch.environment_instance?.access_urls ?? []).flatMap((entry) => {
    const url = safeHttpUrl(entry.url);
    const name = entry.name.trim();
    const identity = name.toLocaleLowerCase('en-US');
    if (!url || !name || seen.has(identity)) return [];
    seen.add(identity);
    return [{ name, url }];
  });
  if (runtime.length > 0) return runtime;
  const staticUrl = safeHttpUrl(branch.app_url, true);
  return staticUrl ? [{ name: 'App', url: staticUrl }] : [];
}

export function getEnvironmentAccessUrl(branch: Branch): string | undefined {
  return getEnvironmentAccessUrls(branch)[0]?.url;
}

/** Whether the daemon has a configured or discovered target to probe. */
export function hasEnvironmentHealthTarget(branch: Branch): boolean {
  const environment = branch.environment_instance;
  return Boolean(
    resolveEnvironmentHealthTarget({
      configuredHealthUrl: branch.health_check_url,
      lifecycleResultHealthUrl: environment?.lifecycle_result?.health_url,
      legacyFactHealthUrl: environment?.facts?.health,
    }).healthUrl
  );
}
