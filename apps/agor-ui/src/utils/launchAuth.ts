import type { AgorClient } from '@agor-live/client';
import type { RefreshResult } from './tokenRefresh';
import { storeTokens } from './tokenRefresh';

export const LAUNCH_CODE_PARAM = 'launch_code';

export function getLaunchCodeFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const value = params.get(LAUNCH_CODE_PARAM);
  return value?.trim() ? value : null;
}

export function removeLaunchCodeFromCurrentUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(LAUNCH_CODE_PARAM)) return;
  url.searchParams.delete(LAUNCH_CODE_PARAM);
  window.history.replaceState(
    window.history.state,
    document.title,
    `${url.pathname}${url.search}${url.hash}`
  );
}

export async function exchangeLaunchCode(
  client: AgorClient,
  launchCode: string
): Promise<RefreshResult> {
  const result = (await client.service('auth/launch').create({ launchCode })) as RefreshResult;
  storeTokens(result.accessToken, result.refreshToken);
  return result;
}
