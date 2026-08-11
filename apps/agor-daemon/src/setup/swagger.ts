/**
 * Swagger/OpenAPI Configuration
 *
 * Configures API documentation using feathers-swagger.
 * Keeps the machine-readable schema local while the documentation site owns
 * the human-facing reference UI.
 */

import type { Application } from '@agor/core/feathers';
import type { Express, Request, Response } from 'express';
import swagger from 'feathers-swagger';

export interface SwaggerOptions {
  /** Daemon version for API docs */
  version: string;
  /** Daemon port for server URL */
  port: number;
}

interface OpenApiOperation {
  description?: string;
  parameters?: Array<{ in?: string; name?: string }>;
  summary?: string;
}

interface OpenApiDocument {
  components?: { schemas?: Record<string, Record<string, unknown>> };
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

/**
 * feathers-swagger emits empty operation summaries, unresolved schema refs for
 * services without an explicit JSON schema, and a private `$ref-value` helper.
 * Swagger UI tolerated those extensions, but they are not valid OpenAPI and
 * strict modern consumers reject the entire path item.
 */
export function normalizeOpenApiDocument(document: OpenApiDocument): void {
  const normalizedPaths: NonNullable<OpenApiDocument['paths']> = {};
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    const occurrences = new Map<string, number>();
    const pathParameterNames: string[] = [];
    const normalizedPath = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const occurrence = (occurrences.get(name) ?? 0) + 1;
      occurrences.set(name, occurrence);
      const normalizedName = occurrence === 1 ? name : `${name}_${occurrence}`;
      pathParameterNames.push(normalizedName);
      return `{${normalizedName}}`;
    });

    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation && !operation.summary?.trim()) {
        operation.summary =
          operation.description?.replace(/\.$/, '') || `${method.toUpperCase()} ${path}`;
      }
      const pathParameters = operation?.parameters?.filter((parameter) => parameter.in === 'path');
      pathParameters?.forEach((parameter, index) => {
        if (pathParameterNames[index]) parameter.name = pathParameterNames[index];
      });
    }
    normalizedPaths[normalizedPath] = pathItem;
  }
  document.paths = normalizedPaths;

  const referencedSchemas = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    delete object['$ref-value'];
    let ref = object.$ref;
    const prefix = '#/components/schemas/';
    if (typeof ref === 'string' && ref.startsWith(prefix)) {
      const rawName = decodeURIComponent(ref.slice(prefix.length));
      const name = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (name !== rawName) {
        ref = `${prefix}${name}`;
        object.$ref = ref;
      }
      referencedSchemas.add(name);
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(document);

  document.components ??= {};
  document.components.schemas ??= {};
  for (const name of referencedSchemas) {
    document.components.schemas[name] ??= {
      type: 'object',
      additionalProperties: true,
      description: `Schema for ${name}. See @agor-live/client for the authoritative TypeScript type.`,
    };
  }
}

/**
 * Configure Swagger/OpenAPI documentation for the daemon
 *
 * Sets up:
 * - OpenAPI 3.0 spec at /docs.json
 * - A stable redirect from /docs to the maintained reference at agor.live
 * - JWT Bearer authentication scheme
 * - Global security requirement (except public endpoints)
 *
 * @param app - FeathersJS application instance
 * @param options - Configuration options
 */
export function configureSwagger(app: Application, options: SwaggerOptions): void {
  const { version, port } = options;

  app.configure(
    swagger({
      openApiVersion: 3,
      docsJsonPath: '/docs.json',
      specs: {
        info: {
          title: 'Agor API',
          description: 'REST and WebSocket API for Agor agent orchestration platform',
          version,
        },
        servers: [{ url: `http://localhost:${port}`, description: 'Local daemon' }],
        components: {
          securitySchemes: {
            BearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
          },
        },
        // Apply BearerAuth globally to all endpoints (except public endpoints like /health, /login)
        security: [{ BearerAuth: [] }],
      },
    })
  );

  // Swagger's service mixin runs first and adds an operation to the shared
  // document. Normalize immediately afterward so /docs.json is consumable by
  // strict modern renderers such as Scalar, not only Swagger UI.
  const documentedApp = app as Application & { docs: OpenApiDocument };
  app.mixins.push(() => normalizeOpenApiDocument(documentedApp.docs));

  // Do not ship an entire documentation SPA in every global npm install.
  // The exact schema for this daemon remains available at /docs.json; the
  // public site renders a versioned snapshot with Scalar.
  (app as unknown as Express).get(['/docs', '/docs/'], (_request: Request, response: Response) => {
    response.redirect(302, 'https://agor.live/api-reference');
  });
}
