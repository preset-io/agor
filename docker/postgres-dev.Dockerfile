# Development PostgreSQL image for Agor.
#
# The official postgres image creates POSTGRES_USER as a superuser. That is
# useful for bootstrap, but it bypasses FORCE ROW LEVEL SECURITY and can hide
# tenant-isolation bugs. This image keeps the bootstrap superuser internal and
# creates a non-superuser application role for the daemon/CLI to use.
FROM pgvector/pgvector:0.8.2-pg16-trixie

# BuildKit can retain a source file's POSIX ACL even with COPY --chmod. Stage it
# first, then create a fresh inode so checkout ACLs cannot make the bootstrap
# script unreadable by the postgres user.
COPY docker/postgres-init-app-user.sql /tmp/agor-init-app-user.sql
RUN install -o root -g root -m 0644 \
  /tmp/agor-init-app-user.sql \
  /docker-entrypoint-initdb.d/10-agor-app-user.sql \
  && rm /tmp/agor-init-app-user.sql
