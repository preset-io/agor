import { UI_MOUNT_PATH } from '@agor-live/client';

export function getRouterBasename(baseUrl = import.meta.env.BASE_URL): string {
  return baseUrl === `${UI_MOUNT_PATH}/` ? UI_MOUNT_PATH : '';
}

export function uiRouteHref(path: string, baseUrl = import.meta.env.BASE_URL): string {
  return `${getRouterBasename(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}
