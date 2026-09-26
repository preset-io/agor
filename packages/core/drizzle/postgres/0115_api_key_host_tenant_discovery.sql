-- A personal API key carries no tenant claim. In hosted required_from_auth
-- deployments the trusted request Host names the workspace, and each tenant's
-- launch-observed public URL lives in app_variables (tenant.routing/public_url).
-- This narrowly named capability may read ONLY those routing rows so the daemon
-- can map Host -> tenant_id before authentication. Key verification then leaves
-- system scope and runs under the discovered tenant's ordinary RLS policy, so
-- the capability never exposes key material or any other tenant variable.
DROP POLICY IF EXISTS "api_key_host_tenant_discovery" ON "app_variables";
--> statement-breakpoint
CREATE POLICY "api_key_host_tenant_discovery"
	ON "app_variables"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'api_key_host_tenant_discovery'
		AND "namespace" = 'tenant.routing'
		AND "key" = 'public_url'
	);
