-- PostgreSQL initialization script for Agor development
-- This grants the necessary permissions for the agor user to run Drizzle migrations

-- Make agor user a superuser for development (simplifies permissions)
-- In production, use granular permissions instead
ALTER USER agor WITH SUPERUSER;

-- Grant all permissions on the public schema (required for PostgreSQL 15+)
GRANT ALL ON SCHEMA public TO agor;

-- Pre-create the drizzle schema (used by Drizzle ORM for migration tracking)
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT ALL ON SCHEMA drizzle TO agor;

-- Grant all default privileges for future objects in both schemas
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO agor;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO agor;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO agor;

ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON TABLES TO agor;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON SEQUENCES TO agor;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON FUNCTIONS TO agor;
