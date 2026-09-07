import { environmentAccessUrlSchema } from '@agor/core/environment/access-urls';
import type { BranchEnvironmentInstance } from '@agor-live/client';

/** Prefer reported links; retain the static app fallback for existing environments. */
export function getEnvironmentAccessUrls(environment?: BranchEnvironmentInstance, appUrl?: string) {
  const reported = Array.isArray(environment?.access_urls) ? environment.access_urls : [];
  const links = reported.slice(0, 8).flatMap((entry) => {
    const parsed = environmentAccessUrlSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (links.length) return links;
  const fallback = environmentAccessUrlSchema.safeParse({ name: 'App', url: appUrl });
  return fallback.success ? [fallback.data] : [];
}
