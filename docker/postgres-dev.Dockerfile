# Development PostgreSQL image for Agor.
#
# The official postgres image creates POSTGRES_USER as a superuser. That is
# useful for bootstrap, but it bypasses FORCE ROW LEVEL SECURITY and can hide
# tenant-isolation bugs. This image keeps the bootstrap superuser internal and
# creates a non-superuser application role for the daemon/CLI to use.
FROM pgvector/pgvector:0.8.2-pg16-trixie

COPY docker/postgres-init-app-user.sql /docker-entrypoint-initdb.d/10-agor-app-user.sql
