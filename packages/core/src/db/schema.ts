/**
 * Schema Re-Export with Runtime Dialect Detection
 *
 * This file exports the correct schema based on the database dialect detected at module load time.
 *
 * IMPORTANT: The AGOR_DB_DIALECT environment variable must be set BEFORE any code imports this module.
 * If using PostgreSQL, ensure AGOR_DB_DIALECT=postgresql is set when the process starts.
 *
 * The dialect detection happens at module load time (when this file is first imported).
 * This is necessary because TypeScript/Drizzle requires the actual table objects, not proxies.
 */

import * as postgresSchema from './schema.postgres';
import * as sqliteSchema from './schema.sqlite';
import { getDatabaseDialect } from './schema-factory';

// Determine which schema to use based on runtime dialect
// This is evaluated once at module load time
const dialect = getDatabaseDialect();
const schema = dialect === 'postgresql' ? postgresSchema : sqliteSchema;

// Re-export all tables from the selected schema
export const sessions = schema.sessions;
export const tasks = schema.tasks;
export const messages = schema.messages;
export const boards = schema.boards;
export const repos = schema.repos;
export const worktrees = schema.worktrees;
export const worktreeOwners = schema.worktreeOwners;
export const users = schema.users;
export const mcpServers = schema.mcpServers;
export const boardObjects = schema.boardObjects;
export const sessionMcpServers = schema.sessionMcpServers;
export const boardComments = schema.boardComments;

// Re-export all types
export type * from './schema.sqlite';
