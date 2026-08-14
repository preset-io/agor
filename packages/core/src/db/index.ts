// Schema and types

// Drizzle ORM re-exports (so daemon doesn't import drizzle-orm directly)
// Commonly used operators and utilities
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

// bcryptjs re-export (for password hashing in daemon)
// bcryptjs is a CommonJS module, so we import the default and re-export specific functions
import bcryptjs from 'bcryptjs';
export const compare = bcryptjs.compare;
export const hash = bcryptjs.hash;

// ID utilities (re-exported from lib for convenience)
export { generateId, IdResolutionError, resolveShortId, shortId } from '../lib/ids';

// Slug utilities
export { generateSlug, generateUniqueSlug, identifyUrlParam, isShortId } from '../lib/slugs';
// Client and database
export * from './client';

// Database wrapper utilities (type-safe operations for union Database type)
export * from './database-wrapper';

// Encryption utilities
export * from './encryption';
// First-run admin bootstrap (creates default admin if no users exist; also
// re-attributes legacy 'anonymous' created_by rows from removed anonymous mode)
export * from './first-run-bootstrap';
// Migrations
export * from './migrate';
export * from './oauth-secret-envelope';
// Pending-migrations presentation (shared by CLI and daemon)
export * from './pending-migrations';
// Repositories
export * from './repositories';
export * from './sanitize-error';
export * from './schema';
export { detectDialectFromUrl, getDatabaseDialect } from './schema-factory';
// Session guard utilities (defensive programming for deleted sessions)
export * from './session-guard';
// Tenant database lifecycle primitives. Filesystem-backed portability operations
// live at @agor/core/tenant-portability so importing the daemon's database
// surface does not implicitly grant host-filesystem capabilities.
export * from './tenant-catalog';
// Tenant deletion (permanent, audited, idempotent per-tenant erasure)
export * from './tenant-deletion';
export * from './tenant-deletion-manifest';
export * from './tenant-imperative-tables';
export * from './tenant-portability-manifest';
export * from './tenant-scope';
export * from './tenant-unit-of-work';
// Tenant write gate (generation-bound per-tenant write freeze)
export * from './tenant-write-gate';
// User utilities
export * from './user-utils';
