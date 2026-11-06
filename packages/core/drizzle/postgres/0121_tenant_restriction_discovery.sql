-- The restriction reconciler first asks which tenants are closed, so a runtime
-- with nothing restricted pages no tasks. The narrowly named capability learns
-- tenant ids only: the policy admits non-active rows solely while
-- agor_restricted_tenant_ids() runs, because only that function turns on the
-- internal flag (and off again before returning), and it returns tenant_id
-- alone. A direct SELECT under the capability sees nothing, so controller,
-- placement, operation and revision stay behind each tenant's ordinary RLS
-- scope. Like every capability setting this guards trusted code against
-- accidental whole-row reads, not against code that sets the flag on purpose.
-- The capability grants no write and never exposes an open tenant's history.
DROP POLICY IF EXISTS "tenant_restriction_discovery" ON "tenant_restrictions";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agor_restricted_tenant_ids() RETURNS TABLE ("tenant_id" text)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- is_local = true and reset below; an aborted (sub)transaction discards it. A function-level SET of this custom setting is refused for the app role.
  PERFORM pg_catalog.set_config('agor.tenant_restriction_discovery_ids', 'on', true);
  RETURN QUERY
    SELECT DISTINCT r."tenant_id"
    FROM public."tenant_restrictions" AS r
    WHERE r."phase" <> 'active';
  PERFORM pg_catalog.set_config('agor.tenant_restriction_discovery_ids', '', true);
END
$$;
--> statement-breakpoint
CREATE POLICY "tenant_restriction_discovery"
  ON "tenant_restrictions"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'tenant_restriction_discovery'
    AND current_setting('agor.tenant_restriction_discovery_ids', true) = 'on'
    AND "phase" <> 'active'
  );
