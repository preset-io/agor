-- IDs-only maintenance discovery. No token/handle/ciphertext SELECT capability
-- is granted to the application role. Definer inputs are bound scalars only.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER POLICY tenant_isolation_user_mcp_oauth_tokens ON user_mcp_oauth_tokens
 USING ((credential_origin='direct' OR COALESCE(current_setting('agor.system_scope',true),'')='')
 AND tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'))
 WITH CHECK ((credential_origin='direct' OR COALESCE(current_setting('agor.system_scope',true),'')='')
 AND tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'));
--> statement-breakpoint
CREATE FUNCTION public.agor_mcp_managed_oauth_maintenance_tenants(after_tenant text DEFAULT NULL, page_size integer DEFAULT 100)
 RETURNS TABLE(tenant_id text) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 BEGIN
  IF current_setting('agor.system_scope',true) IS DISTINCT FROM 'mcp_oauth_maintenance'
    OR page_size IS NULL OR page_size<1 OR page_size>100 OR length(after_tenant)>1024 THEN
   RAISE EXCEPTION 'managed OAuth routing capability required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT candidates.tenant_id FROM (
   (SELECT DISTINCT p.tenant_id COLLATE "C" AS tenant_id FROM public.mcp_oauth_pending_flows p
    WHERE p.credential_origin='cloud_managed_v1' AND p.status IN ('pending','exchanging')
      AND (after_tenant IS NULL OR p.tenant_id COLLATE "C">after_tenant COLLATE "C") ORDER BY 1 LIMIT page_size)
   UNION
   (SELECT DISTINCT t.tenant_id COLLATE "C" AS tenant_id FROM public.user_mcp_oauth_tokens t
    WHERE t.credential_origin='cloud_managed_v1' AND (after_tenant IS NULL OR t.tenant_id COLLATE "C">after_tenant COLLATE "C") ORDER BY 1 LIMIT page_size)
   UNION
   (SELECT DISTINCT o.tenant_id COLLATE "C" AS tenant_id FROM public.mcp_managed_oauth_outbox o
    WHERE o.completed_at IS NULL AND (after_tenant IS NULL OR o.tenant_id COLLATE "C">after_tenant COLLATE "C") ORDER BY 1 LIMIT page_size)
  ) candidates ORDER BY candidates.tenant_id COLLATE "C" LIMIT page_size;
 END $$;
--> statement-breakpoint
CREATE POLICY managed_oauth_owner_routing_select ON user_mcp_oauth_tokens FOR SELECT USING (
 credential_origin='cloud_managed_v1' AND current_setting('agor.system_scope',true)='mcp_oauth_maintenance'
 AND pg_catalog.pg_has_role(current_user,(SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.agor_mcp_managed_oauth_maintenance_tenants(text,integer)'::regprocedure),'MEMBER'));
--> statement-breakpoint
CREATE POLICY managed_oauth_owner_routing_select ON mcp_oauth_pending_flows FOR SELECT USING (
 credential_origin='cloud_managed_v1' AND current_setting('agor.system_scope',true)='mcp_oauth_maintenance'
 AND pg_catalog.pg_has_role(current_user,(SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.agor_mcp_managed_oauth_maintenance_tenants(text,integer)'::regprocedure),'MEMBER'));
--> statement-breakpoint
CREATE POLICY managed_oauth_owner_routing_select ON mcp_managed_oauth_outbox FOR SELECT USING (
 current_setting('agor.system_scope',true)='mcp_oauth_maintenance'
 AND pg_catalog.pg_has_role(current_user,(SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.agor_mcp_managed_oauth_maintenance_tenants(text,integer)'::regprocedure),'MEMBER'));
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.agor_mcp_managed_oauth_maintenance_tenants(text,integer) FROM PUBLIC;
--> statement-breakpoint
-- Execute is safe only because the body itself requires the explicit capability
-- and returns no row material other than tenant routing IDs.
GRANT EXECUTE ON FUNCTION public.agor_mcp_managed_oauth_maintenance_tenants(text,integer) TO PUBLIC;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
