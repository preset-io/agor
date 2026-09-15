SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD COLUMN credential_origin text NOT NULL DEFAULT 'direct';
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD COLUMN managed_metadata jsonb;
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD COLUMN managed_operation_id text;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN credential_origin text NOT NULL DEFAULT 'direct';
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN managed_metadata jsonb;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN managed_operation_id text;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN managed_refresh_not_before timestamp with time zone;
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD COLUMN managed_transaction_id text;
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD COLUMN oauth_token_endpoint_auth_method text;
--> statement-breakpoint
CREATE TABLE mcp_managed_oauth_outbox (
 tenant_id text NOT NULL DEFAULT 'default', outbox_id text PRIMARY KEY, outbox_key text NOT NULL, operation_id text NOT NULL,
 kind text NOT NULL, attempt_id text NOT NULL, user_id text NOT NULL, mcp_server_id text NOT NULL,
 grant_generation text NOT NULL, managed_metadata jsonb NOT NULL, transaction_id text,
 sealed_material text, created_at timestamp with time zone NOT NULL, expires_at timestamp with time zone NOT NULL, completed_at timestamp with time zone);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_managed_oauth_outbox_key_uq ON mcp_managed_oauth_outbox (tenant_id, outbox_key);
--> statement-breakpoint
CREATE TABLE mcp_managed_oauth_invalidations (
 tenant_id text NOT NULL DEFAULT 'default', scope_key text PRIMARY KEY, cell_id text NOT NULL, environment text NOT NULL,
 residency_region text NOT NULL, recovery_incarnation text NOT NULL, status text NOT NULL,
 cursor text, page_digest text, items jsonb NOT NULL, staged_items jsonb NOT NULL, updated_at timestamp with time zone NOT NULL);
--> statement-breakpoint
ALTER TABLE mcp_managed_oauth_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mcp_managed_oauth_outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_mcp_managed_oauth_outbox ON mcp_managed_oauth_outbox USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')) WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE mcp_managed_oauth_invalidations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mcp_managed_oauth_invalidations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_mcp_managed_oauth_invalidations ON mcp_managed_oauth_invalidations USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')) WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER POLICY mcp_oauth_callback_select ON mcp_oauth_pending_flows USING (
 current_setting('agor.system_scope', true) = 'mcp_oauth_callback'
 AND credential_origin = 'direct' AND state_hash = current_setting('agor.oauth_state_hash', true));
--> statement-breakpoint
ALTER POLICY mcp_oauth_callback_update ON mcp_oauth_pending_flows USING (
 current_setting('agor.system_scope', true) = 'mcp_oauth_callback' AND credential_origin = 'direct'
 AND state_hash = current_setting('agor.oauth_state_hash', true) AND status = 'pending') WITH CHECK (
 current_setting('agor.system_scope', true) = 'mcp_oauth_callback' AND credential_origin = 'direct'
 AND state_hash = current_setting('agor.oauth_state_hash', true) AND status IN ('exchanging','failed','expired'));
--> statement-breakpoint
CREATE POLICY mcp_managed_oauth_outbox_maintenance_insert ON mcp_managed_oauth_outbox FOR INSERT WITH CHECK (
 current_setting('agor.system_scope', true) = 'mcp_oauth_maintenance' AND pg_trigger_depth() > 0
 AND kind IN ('cancel','recover_prepare_cancel') AND sealed_material IS NULL AND completed_at IS NULL);
--> statement-breakpoint
CREATE FUNCTION public.mcp_managed_oauth_retire_pending() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, public, pg_temp AS $$
 BEGIN
 IF OLD.credential_origin = 'cloud_managed_v1' AND OLD.status IN ('pending','exchanging')
   AND (TG_OP = 'DELETE' OR NEW.status IN ('failed','ambiguous','expired') OR NOT NEW.is_current) THEN
  INSERT INTO public.mcp_managed_oauth_outbox
  (tenant_id,outbox_id,outbox_key,operation_id,kind,attempt_id,user_id,mcp_server_id,grant_generation,managed_metadata,transaction_id,created_at,expires_at)
  VALUES (OLD.tenant_id,gen_random_uuid()::text,'cancel:'||OLD.attempt_id,gen_random_uuid()::text,
   CASE WHEN OLD.managed_transaction_id IS NULL THEN 'recover_prepare_cancel' ELSE 'cancel' END,
   OLD.attempt_id,OLD.user_id,OLD.mcp_server_id,OLD.grant_generation::text,OLD.managed_metadata,
   OLD.managed_transaction_id,clock_timestamp(),clock_timestamp()+interval '24 hours') ON CONFLICT DO NOTHING;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
 END $$;
--> statement-breakpoint
CREATE TRIGGER mcp_managed_oauth_pending_retirement BEFORE UPDATE OR DELETE ON mcp_oauth_pending_flows FOR EACH ROW EXECUTE FUNCTION public.mcp_managed_oauth_retire_pending();
--> statement-breakpoint
CREATE FUNCTION public.mcp_managed_oauth_retire_grant() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, public, pg_temp AS $$
 BEGIN
 IF OLD.credential_origin = 'cloud_managed_v1' AND
   (TG_OP = 'DELETE' OR NEW.grant_generation IS DISTINCT FROM OLD.grant_generation OR NEW.credential_origin <> 'cloud_managed_v1'
    OR (NEW.refresh_status = 'ambiguous' AND OLD.refresh_status <> 'ambiguous')) THEN
  INSERT INTO public.mcp_managed_oauth_outbox
  (tenant_id,outbox_id,outbox_key,operation_id,kind,attempt_id,user_id,mcp_server_id,grant_generation,managed_metadata,transaction_id,sealed_material,created_at,expires_at)
  VALUES (OLD.tenant_id,gen_random_uuid()::text,'close:'||(OLD.managed_metadata->>'handle'),gen_random_uuid()::text,'close',
   OLD.managed_metadata->'owner'->>'attempt_id',OLD.user_id,OLD.mcp_server_id,OLD.grant_generation::text,
   OLD.managed_metadata,OLD.managed_metadata->>'transaction_id',OLD.oauth_refresh_token,clock_timestamp(),clock_timestamp()+interval '24 hours') ON CONFLICT DO NOTHING;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
 END $$;
--> statement-breakpoint
CREATE TRIGGER mcp_managed_oauth_grant_retirement BEFORE UPDATE OR DELETE ON user_mcp_oauth_tokens FOR EACH ROW EXECUTE FUNCTION public.mcp_managed_oauth_retire_grant();
--> statement-breakpoint
CREATE FUNCTION public.mcp_managed_oauth_user_change() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, public, pg_temp AS $$
 BEGIN
 IF NEW.role IS DISTINCT FROM OLD.role THEN
  UPDATE public.mcp_oauth_pending_flows SET status=CASE WHEN status='exchanging' THEN 'ambiguous' ELSE 'failed' END,
   is_current=false,sealed_material=NULL,failure_code='subject_role_changed',finished_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id AND credential_origin='cloud_managed_v1' AND status IN ('pending','exchanging');
  DELETE FROM public.user_mcp_oauth_tokens WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id AND credential_origin='cloud_managed_v1';
 END IF;
 RETURN NEW;
 END $$;
--> statement-breakpoint
CREATE TRIGGER mcp_managed_oauth_user_change AFTER UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION public.mcp_managed_oauth_user_change();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mcp_managed_oauth_retire_pending() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mcp_managed_oauth_retire_grant() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mcp_managed_oauth_user_change() FROM PUBLIC;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
--> statement-breakpoint
CREATE FUNCTION public.mcp_managed_oauth_identity_change() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, public, pg_temp AS $$
 BEGIN
 IF TG_OP='DELETE' OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.subject IS DISTINCT FROM OLD.subject
   OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.issuer IS DISTINCT FROM OLD.issuer THEN
  UPDATE public.mcp_oauth_pending_flows SET status=CASE WHEN status='exchanging' THEN 'ambiguous' ELSE 'failed' END,
   is_current=false,sealed_material=NULL,failure_code='subject_identity_changed',finished_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id AND credential_origin='cloud_managed_v1' AND status IN ('pending','exchanging');
  DELETE FROM public.user_mcp_oauth_tokens WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id AND credential_origin='cloud_managed_v1';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
 END $$;
--> statement-breakpoint
CREATE TRIGGER mcp_managed_oauth_identity_retirement BEFORE UPDATE OR DELETE ON user_external_identities FOR EACH ROW EXECUTE FUNCTION public.mcp_managed_oauth_identity_change();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mcp_managed_oauth_identity_change() FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE mcp_oauth_pending_flows ADD CONSTRAINT mcp_pending_managed_origin CHECK ((
 (credential_origin='direct' AND managed_metadata IS NULL AND managed_transaction_id IS NULL AND managed_operation_id IS NULL AND config_fingerprint_version<>5)
 OR (credential_origin='cloud_managed_v1' AND oauth_mode='per_user' AND subject_user_id=user_id AND config_fingerprint_version=5 AND managed_metadata IS NOT NULL
 AND managed_metadata->'owner'->>'workspace_id'=tenant_id AND managed_metadata->'owner'->>'cell_local_user_id'=user_id
 AND managed_metadata->'owner'->>'server_id'=mcp_server_id AND managed_metadata->'owner'->>'attempt_id'=attempt_id
 AND managed_metadata->'owner'->>'grant_generation'=grant_generation::text AND managed_metadata->'owner'->>'config_fingerprint'=config_fingerprint
 AND managed_metadata->'owner'=managed_metadata->'prepare_request'->'owner')) IS TRUE);
--> statement-breakpoint
ALTER TABLE user_mcp_oauth_tokens ADD CONSTRAINT mcp_grant_managed_origin CHECK ((
 (credential_origin='direct' AND managed_metadata IS NULL AND managed_operation_id IS NULL AND managed_refresh_not_before IS NULL AND grant_binding_version IS DISTINCT FROM 5)
 OR (credential_origin='cloud_managed_v1' AND user_id IS NOT NULL AND grant_binding_version=5 AND managed_metadata IS NOT NULL AND oauth_client_secret IS NULL
 AND managed_metadata->'owner'->>'workspace_id'=tenant_id AND managed_metadata->'owner'->>'cell_local_user_id'=user_id
 AND managed_metadata->'owner'->>'server_id'=mcp_server_id AND managed_metadata->'owner'->>'grant_generation'=grant_generation::text
 AND managed_metadata->'owner'->>'config_fingerprint'=grant_binding_fingerprint)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION public.mcp_managed_oauth_completion_deadline() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, public, pg_temp AS $$
 DECLARE started timestamptz;
 BEGIN
 IF NEW.credential_origin <> 'cloud_managed_v1' THEN RETURN NULL; END IF;
 IF TG_OP='INSERT' OR NEW.managed_metadata->>'operation_id' IS DISTINCT FROM OLD.managed_metadata->>'operation_id' THEN
  started=to_timestamp((NEW.managed_metadata->'claim'->>'claimed_at')::numeric/1000);
 ELSIF OLD.refresh_status='refreshing' AND NEW.refresh_status='idle' THEN
  started=OLD.refresh_claimed_at;
 ELSE RETURN NULL;
 END IF;
 IF started IS NULL OR started > clock_timestamp() OR started <= clock_timestamp()-interval '2 minutes' THEN
  RAISE EXCEPTION 'managed OAuth original claim deadline exceeded' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
 END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER mcp_managed_oauth_completion_deadline AFTER INSERT OR UPDATE ON user_mcp_oauth_tokens DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.mcp_managed_oauth_completion_deadline();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mcp_managed_oauth_completion_deadline() FROM PUBLIC;

--> statement-breakpoint
DROP INDEX mcp_servers_catalog_owner_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_servers_catalog_owner_uq ON mcp_servers (tenant_id, coalesce(owner_user_id, ''), catalog_entry_name, (coalesce(data->'auth'->>'oauth_client_mode', 'direct'))) WHERE source='catalog' AND catalog_entry_name IS NOT NULL;
