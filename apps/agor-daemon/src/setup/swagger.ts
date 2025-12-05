/**
 * Swagger/OpenAPI Configuration
 *
 * Configures API documentation using feathers-swagger.
 * Provides interactive API docs at /docs endpoint.
 */

import type { Application } from '@agor/core/feathers';
import swagger from 'feathers-swagger';

export interface SwaggerOptions {
  /** Daemon version for API docs */
  version: string;
  /** Daemon port for server URL */
  port: number;
}

/**
 * Configure Swagger/OpenAPI documentation for the daemon
 *
 * Sets up:
 * - OpenAPI 3.0 spec at /docs.json
 * - Swagger UI at /docs
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
      docsPath: '/docs',
      docsJsonPath: '/docs.json',
      ui: swagger.swaggerUI({ docsPath: '/docs' }),
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
}
