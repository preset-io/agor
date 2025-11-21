// Schema and types

// Drizzle ORM re-exports (so daemon doesn't import drizzle-orm directly)
// Commonly used operators and utilities
export { and, asc, desc, eq, inArray, like, or, type SQL, sql } from 'drizzle-orm';

// bcryptjs re-export (for password hashing in daemon)
// bcryptjs is a CommonJS module, so we import the default and re-export specific functions
import bcryptjs from 'bcryptjs';
export const compare = bcryptjs.compare;
export const hash = bcryptjs.hash;

// ID utilities (re-exported from lib for convenience)
export { formatShortId, generateId, IdResolutionError, resolveShortId } from '../lib/ids';

// Slug utilities
export { generateSlug, generateUniqueSlug, identifyUrlParam, isShortId } from '../lib/slugs';
// Client and database
export * from './client';

// Database wrapper utilities (type-safe operations for union Database type)
export * from './database-wrapper';

// Encryption utilities
export * from './encryption';

// Migrations
export * from './migrate';
// Repositories
export * from './repositories';
export * from './schema';
// Session guard utilities (defensive programming for deleted sessions)
export * from './session-guard';
// User utilities
export * from './user-utils';
