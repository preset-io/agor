-- Deployment authority only: never tenant-owned, portable, expiring or automatically reopened.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE public.mcp_managed_oauth_cell_retirements (
 cell_id text PRIMARY KEY CHECK (cell_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 generation text NOT NULL CHECK (generation ~ '^[A-Za-z0-9_-]{1,128}$'),
 created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.mcp_managed_oauth_cell_retirements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_managed_oauth_cell_retirements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY managed_cell_retirement_read ON public.mcp_managed_oauth_cell_retirements FOR SELECT
 USING (current_setting('agor.system_scope',true)='mcp_oauth_maintenance');
--> statement-breakpoint
CREATE POLICY managed_cell_retirement_insert ON public.mcp_managed_oauth_cell_retirements FOR INSERT
 WITH CHECK (current_setting('agor.system_scope',true)='mcp_oauth_maintenance');
--> statement-breakpoint
-- No UPDATE or DELETE policy: an admitted stop cannot expire or reopen.
CREATE FUNCTION public.agor_mcp_managed_oauth_cell_vending_allowed(requested_cell text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 BEGIN
  IF requested_cell IS NULL OR requested_cell !~ '^[A-Za-z0-9_-]{1,128}$'
    OR NULLIF(current_setting('agor.tenant_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'managed cell vending requires tenant authority' USING ERRCODE='42501';
  END IF;
  -- Shared with beginManagedOAuthCellRetirement's exclusive lock. No absence race.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('agor:mcp-managed-cell-retirement:v1:'||requested_cell,0));
  RETURN NOT EXISTS(SELECT 1 FROM public.mcp_managed_oauth_cell_retirements WHERE cell_id=requested_cell);
 END $$;
--> statement-breakpoint
CREATE POLICY managed_cell_retirement_definer_read ON public.mcp_managed_oauth_cell_retirements FOR SELECT
 USING (pg_catalog.pg_has_role(current_user,
   (SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.agor_mcp_managed_oauth_cell_vending_allowed(text)'::regprocedure),'MEMBER'));
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.agor_mcp_managed_oauth_cell_vending_allowed(text) FROM PUBLIC;
--> statement-breakpoint
-- Only a boolean is exposed; operation/generation never cross into a tenant read.
GRANT EXECUTE ON FUNCTION public.agor_mcp_managed_oauth_cell_vending_allowed(text) TO PUBLIC;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
