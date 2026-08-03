-- Permit only deployment-local upload maintenance discovery to enumerate the
-- tenant IDs of expired upload rows. Full rows are subsequently loaded and
-- deleted under each tenant's ordinary RLS scope.
CREATE POLICY "upload_maintenance_discovery" ON "uploads"
  FOR SELECT
  USING (
    "expires_at" IS NOT NULL
    AND "expires_at" < CURRENT_TIMESTAMP
    AND current_setting('agor.system_scope', true) = 'upload_maintenance'
  );
