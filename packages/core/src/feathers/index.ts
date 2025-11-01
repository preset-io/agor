/**
 * FeathersJS Runtime Re-exports
 *
 * Core re-exports all FeathersJS runtime dependencies so apps
 * can import through @agor/core/feathers instead of directly.
 *
 * This allows:
 * - Single source of truth for FeathersJS versions
 * - Apps depend only on @agor/core
 * - Easy to swap implementations later
 */

// Authentication
export {
  AuthenticationBaseStrategy,
  AuthenticationService,
  authenticate,
  JWTStrategy,
} from '@feathersjs/authentication';
export { default as authClient } from '@feathersjs/authentication-client';
export { LocalStrategy } from '@feathersjs/authentication-local';
// Errors
export { Forbidden, NotAuthenticated } from '@feathersjs/errors';
export type { Application as ExpressApplication } from '@feathersjs/express';
// Express Integration
export { default as feathersExpress, errorHandler, rest } from '@feathersjs/express';
export type { Application, Service, ServiceMethods } from '@feathersjs/feathers';
// Core Feathers
export { feathers } from '@feathersjs/feathers';
// Socket.io Integration
export { default as socketio } from '@feathersjs/socketio';
// Client (these are already exported from @agor/core/api)
// Re-export here for convenience
export { default as socketioClient } from '@feathersjs/socketio-client';
