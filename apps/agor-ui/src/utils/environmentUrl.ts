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

/** Prefer the runtime URL reported by a lifecycle bridge over its static template. */
export function getEnvironmentAccessUrl(branch: Branch): string | undefined {
  const runtimeUrls = branch.environment_instance?.access_urls ?? [];
  const namedApp = runtimeUrls.find((entry) => entry.name.toLowerCase() === 'app');
  return (
    safeHttpUrl(namedApp?.url) ??
    runtimeUrls.map((entry) => safeHttpUrl(entry.url)).find(Boolean) ??
    safeHttpUrl(branch.app_url, true)
  );
}
