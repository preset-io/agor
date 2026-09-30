-- The restriction reconciler first asks which tenants are closed, so a runtime
-- with nothing restricted pages no tasks. This narrowly named capability may
-- read ONLY non-active restriction rows; the caller selects tenant ids alone,
-- then re-reads each tenant's full state under its ordinary RLS scope. It
-- grants no write and never exposes an open tenant's history.
DROP POLICY IF EXISTS "tenant_restriction_discovery" ON "tenant_restrictions";
--> statement-breakpoint
CREATE POLICY "tenant_restriction_discovery"
  ON "tenant_restrictions"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'tenant_restriction_discovery'
    AND "phase" <> 'active'
  );
