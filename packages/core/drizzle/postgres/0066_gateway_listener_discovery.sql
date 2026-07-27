-- Permit only the gateway startup discovery transaction to see enabled
-- channel routing metadata across tenants. The daemon sets agor.system_scope
-- transaction-locally, leaves this scope immediately after reading IDs and
-- tenant IDs, then reloads every channel under its tenant's normal RLS scope.

DROP POLICY IF EXISTS "gateway_listener_discovery" ON "gateway_channels";
--> statement-breakpoint
CREATE POLICY "gateway_listener_discovery" ON "gateway_channels"
  FOR SELECT
  USING (
    "enabled" = true
    AND current_setting('agor.system_scope', true) = 'gateway_listener_discovery'
  );
