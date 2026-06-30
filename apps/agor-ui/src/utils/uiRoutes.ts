import { resolveUiRuntime, routerBasenameForRuntime } from '../config/urlRuntime';

function currentPathname(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

export function getRouterBasename(
  baseUrl = import.meta.env.BASE_URL,
  pathname = currentPathname()
): string {
  return routerBasenameForRuntime(resolveUiRuntime({ baseUrl, pathname }));
}

export function uiRouteHref(path: string, baseUrl = import.meta.env.BASE_URL): string {
  return `${getRouterBasename(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}
