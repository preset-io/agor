-- Development-only bootstrap for Agor's PostgreSQL profile.
--
-- POSTGRES_USER from the official image remains a bootstrap superuser. Agor's
-- app connects as agor_app, a non-superuser, so PostgreSQL RLS is exercised in
-- local/dev environments instead of being silently bypassed.

CREATE ROLE agor_app
  LOGIN
  PASSWORD 'agor_dev_secret'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;

GRANT CONNECT, TEMPORARY, CREATE ON DATABASE agor TO agor_app;

-- Let Drizzle create and mutate objects without making the runtime role a
-- superuser. Future app-created objects are owned by agor_app; RLS migrations
-- also FORCE ROW LEVEL SECURITY so the owner is still subject to tenant
-- policies.
ALTER SCHEMA public OWNER TO agor_app;
GRANT ALL ON SCHEMA public TO agor_app;

CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION agor_app;
GRANT ALL ON SCHEMA drizzle TO agor_app;

ALTER DEFAULT PRIVILEGES FOR ROLE agor_app IN SCHEMA public GRANT ALL ON TABLES TO agor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agor_app IN SCHEMA public GRANT ALL ON SEQUENCES TO agor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agor_app IN SCHEMA public GRANT ALL ON FUNCTIONS TO agor_app;

ALTER DEFAULT PRIVILEGES FOR ROLE agor_app IN SCHEMA drizzle GRANT ALL ON TABLES TO agor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agor_app IN SCHEMA drizzle GRANT ALL ON SEQUENCES TO agor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agor_app IN SCHEMA drizzle GRANT ALL ON FUNCTIONS TO agor_app;
