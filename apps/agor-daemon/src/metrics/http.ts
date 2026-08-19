import { performance } from 'node:perf_hooks';
import type express from 'express';
import type { Application } from '../declarations.js';
import type { DaemonMetrics } from './types.js';

const SAFE_ROUTE_TEMPLATE = /^\/[a-zA-Z0-9_./:-]{0,159}$/;
const STATIC_HTTP_ROUTES = new Set(['/livez', '/readyz', '/mcp']);

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function routeTemplateFromExpress(request: express.Request): string | undefined {
  const routePath = (request.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath !== 'string') return undefined;
  const candidate = normalizePath(`${request.baseUrl ?? ''}${routePath}`);
  return SAFE_ROUTE_TEMPLATE.test(candidate) ? candidate : undefined;
}

function routeTemplateFromServices(
  requestPath: string,
  servicePaths: readonly string[]
): string | undefined {
  const requestSegments = normalizePath(requestPath).split('/').filter(Boolean);
  const candidates = [...servicePaths].sort((left, right) => right.length - left.length);
  for (const servicePath of candidates) {
    const serviceSegments = servicePath.split('/').filter(Boolean);
    if (
      requestSegments.length !== serviceSegments.length &&
      requestSegments.length !== serviceSegments.length + 1
    ) {
      continue;
    }
    if (!serviceSegments.every((segment, index) => segment === requestSegments[index])) continue;
    const base = `/${serviceSegments.join('/')}`;
    return requestSegments.length === serviceSegments.length ? base : `${base}/:id`;
  }
  return undefined;
}

/** Return only code-defined templates. Raw request paths are never metric tags. */
export function normalizedHttpRoute(
  request: express.Request,
  app: Pick<Application, 'services'>
): string {
  const expressTemplate = routeTemplateFromExpress(request);
  if (expressTemplate) return expressTemplate;

  const requestPath = normalizePath(request.path);
  const serviceTemplate = routeTemplateFromServices(requestPath, Object.keys(app.services));
  if (serviceTemplate) return serviceTemplate;
  if (STATIC_HTTP_ROUTES.has(requestPath)) return requestPath;
  return '/_unmatched';
}

function normalizeHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(normalized)
    ? normalized
    : 'OTHER';
}

function responseOutcome(statusCode: number, aborted: boolean): string {
  if (aborted) return 'aborted';
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  return 'success';
}

export function createHttpMetricsMiddleware(
  app: Application,
  metrics: DaemonMetrics,
  options: { excludedPathPrefixes?: readonly string[] } = {}
): express.RequestHandler {
  if (!metrics.enabled) return (_request, _response, next) => next();

  return (request, response, next) => {
    if (
      options.excludedPathPrefixes?.some(
        (prefix) => request.path === prefix || request.path.startsWith(`${prefix}/`)
      )
    ) {
      next();
      return;
    }
    const startedAt = performance.now();
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      const statusCode = response.statusCode;
      const tags = {
        method: normalizeHttpMethod(request.method),
        route: normalizedHttpRoute(request, app),
        status_code: Number.isInteger(statusCode) ? statusCode : 0,
        outcome: responseOutcome(statusCode, aborted),
      } as const;
      metrics.increment('http.requests', 1, tags);
      metrics.distribution(
        'http.request.duration_ms',
        Math.max(0, performance.now() - startedAt),
        tags
      );
    };
    response.once('finish', () => record(false));
    response.once('close', () => record(!response.writableFinished));
    next();
  };
}
