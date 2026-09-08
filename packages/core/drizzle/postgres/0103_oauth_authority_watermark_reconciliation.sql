-- Reconcile the timestamp-only migration collision shipped on the old PR head
-- b0585d76. Destructive replacement is permitted only for its exact archived
-- DCR schema. Every catalog comparison below is against a temporary reference
-- relation built by this PostgreSQL server from the known DDL, avoiding
-- version-sensitive hard-coded pg_get_expr/pg_get_indexdef output.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE FUNCTION pg_temp.agor_0102_norm(expression text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(COALESCE(expression, ''), '[[:space:]"]+', '', 'g')
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.agor_0102_relation_fingerprint(relation regclass) RETURNS jsonb
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object(
    'table', (
      SELECT jsonb_build_array(
        c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relreplident,
        c.relispartition, c.relnatts, c.relchecks, am.amname, c.reloptions
      )
      FROM pg_class c
      LEFT JOIN pg_am am ON am.oid = c.relam
      WHERE c.oid = relation
    ),
    'columns', (
      SELECT jsonb_agg(jsonb_build_array(
        a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        pg_temp.agor_0102_norm(pg_get_expr(d.adbin, d.adrelid)),
        a.attidentity, a.attgenerated, a.attndims, a.attstorage, a.attcompression,
        coll_ns.nspname, coll.collname
      ) ORDER BY a.attnum)
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
      LEFT JOIN pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
      WHERE a.attrelid = relation AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'constraints', (
      SELECT COALESCE(jsonb_agg(jsonb_build_array(
        con.conname, con.contype, con.condeferrable, con.condeferred,
        con.convalidated, con.conislocal, con.coninhcount, con.connoinherit,
        pg_temp.agor_0102_norm(pg_get_constraintdef(con.oid, false))
      ) ORDER BY con.conname), '[]'::jsonb)
      FROM pg_constraint con
      WHERE con.conrelid = relation AND con.contype <> 'f'
    ),
    'indexes', (
      SELECT COALESCE(jsonb_agg(jsonb_build_array(
        idx.relname, i.indisunique, i.indisprimary, i.indisexclusion,
        i.indimmediate, i.indisclustered, i.indisvalid, i.indcheckxmin,
        i.indisready, i.indislive, i.indisreplident, i.indnkeyatts, i.indnatts,
        am.amname, idx.reloptions,
        to_jsonb(ARRAY(
          SELECT attr.attname
          FROM unnest(i.indkey::smallint[]) WITH ORDINALITY key(attnum, ord)
          LEFT JOIN pg_attribute attr ON attr.attrelid = relation AND attr.attnum = key.attnum
          ORDER BY key.ord
        )),
        to_jsonb(ARRAY(
          SELECT ARRAY[opc_ns.nspname, opc.opcname, opc.opcdefault::text]
          FROM unnest(i.indclass::oid[]) WITH ORDINALITY cls(opcoid, ord)
          JOIN pg_opclass opc ON opc.oid = cls.opcoid
          JOIN pg_namespace opc_ns ON opc_ns.oid = opc.opcnamespace
          ORDER BY cls.ord
        )),
        to_jsonb(ARRAY(
          SELECT CASE WHEN collation_oid = 0 THEN NULL
                      ELSE coll_ns.nspname || '.' || coll.collname END
          FROM unnest(i.indcollation::oid[]) WITH ORDINALITY col(collation_oid, ord)
          LEFT JOIN pg_collation coll ON coll.oid = col.collation_oid
          LEFT JOIN pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
          ORDER BY col.ord
        )),
        to_jsonb(i.indoption::smallint[]),
        pg_temp.agor_0102_norm(pg_get_expr(i.indexprs, i.indrelid)),
        pg_temp.agor_0102_norm(pg_get_expr(i.indpred, i.indrelid))
      ) ORDER BY idx.relname), '[]'::jsonb)
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_am am ON am.oid = idx.relam
      WHERE i.indrelid = relation
    ),
    'policies', (
      SELECT COALESCE(jsonb_agg(jsonb_build_array(
        p.polname, p.polcmd, p.polpermissive, to_jsonb(p.polroles),
        pg_temp.agor_0102_norm(pg_get_expr(p.polqual, p.polrelid)),
        pg_temp.agor_0102_norm(pg_get_expr(p.polwithcheck, p.polrelid))
      ) ORDER BY p.polname), '[]'::jsonb)
      FROM pg_policy p WHERE p.polrelid = relation
    )
  )
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.agor_0102_relation_matches(actual regclass, expected regclass)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT (SELECT relpersistence = 'p' FROM pg_class WHERE oid = actual)
     AND (SELECT relpersistence = 't' FROM pg_class WHERE oid = expected)
     AND pg_temp.agor_0102_relation_fingerprint(actual)
         = pg_temp.agor_0102_relation_fingerprint(expected)
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.agor_0102_fk_matches(
  relation regclass, constraint_name text, referenced_relation regclass,
  local_columns text[], referenced_columns text[], is_deferrable boolean
) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COUNT(*) = 1 AND COALESCE(bool_and(
    con.conname = constraint_name
    AND con.confrelid = referenced_relation
    AND con.condeferrable = is_deferrable AND NOT con.condeferred
    AND con.convalidated AND con.conislocal AND con.coninhcount = 0
    AND con.connoinherit AND con.confupdtype = 'a' AND con.confdeltype = 'c'
    AND con.confmatchtype = 's'
    AND ARRAY(
      SELECT attr.attname::text FROM unnest(con.conkey) WITH ORDINALITY key(attnum, ord)
      JOIN pg_attribute attr ON attr.attrelid = relation AND attr.attnum = key.attnum
      ORDER BY key.ord
    ) = local_columns
    AND ARRAY(
      SELECT attr.attname::text FROM unnest(con.confkey) WITH ORDINALITY key(attnum, ord)
      JOIN pg_attribute attr
        ON attr.attrelid = referenced_relation AND attr.attnum = key.attnum
      ORDER BY key.ord
    ) = referenced_columns
  ), false)
  FROM pg_constraint con WHERE con.conrelid = relation AND con.contype = 'f'
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.agor_0102_sequence_matches(actual regclass, expected regclass)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT (SELECT relkind = 'S' AND relpersistence = 'p' FROM pg_class WHERE oid = actual)
     AND (SELECT relkind = 'S' AND relpersistence = 't' FROM pg_class WHERE oid = expected)
     AND (SELECT jsonb_build_array(seqtypid::regtype::text, seqstart, seqincrement,
              seqmax, seqmin, seqcache, seqcycle)
          FROM pg_sequence WHERE seqrelid = actual)
       = (SELECT jsonb_build_array(seqtypid::regtype::text, seqstart, seqincrement,
              seqmax, seqmin, seqcache, seqcycle)
          FROM pg_sequence WHERE seqrelid = expected)
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend
       WHERE classid = 'pg_class'::regclass AND objid = actual
         AND refclassid = 'pg_class'::regclass AND deptype IN ('a', 'i')
     )
$$;
--> statement-breakpoint
-- Exact archived b0585d76 reference. Its one FK is checked structurally below
-- because PostgreSQL does not permit a temporary table to reference a
-- permanent table.
CREATE TEMP SEQUENCE agor_0102_legacy_generation_expected;
--> statement-breakpoint
CREATE TEMP TABLE agor_0102_legacy_dcr_expected (
  tenant_id text DEFAULT 'default' NOT NULL,
  registration_id varchar(36) CONSTRAINT mcp_oauth_client_registrations_pkey PRIMARY KEY NOT NULL,
  mcp_server_id varchar(36) NOT NULL,
  registration_generation bigint NOT NULL,
  binding_version integer NOT NULL,
  binding_fingerprint varchar(64) NOT NULL,
  server_config_version integer NOT NULL,
  envelope_version integer NOT NULL,
  is_current boolean DEFAULT true NOT NULL,
  status text DEFAULT 'registering' NOT NULL,
  sealed_material text,
  claim_id varchar(36),
  claim_generation bigint DEFAULT 0 NOT NULL,
  lease_expires_at timestamp with time zone,
  dispatched_at timestamp with time zone,
  client_secret_expires_at timestamp with time zone,
  failure_code text,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  finished_at timestamp with time zone,
  CONSTRAINT mcp_oauth_client_registrations_status_check CHECK (status IN (
    'registering','registered','failed','ambiguous','superseded','expired'
  )),
  CONSTRAINT mcp_oauth_client_registrations_versions_check CHECK (
    registration_generation > 0 AND binding_version = 1
    AND server_config_version > 0 AND envelope_version > 0
    AND claim_generation >= 0
  ),
  CONSTRAINT mcp_oauth_client_registrations_lifecycle_check CHECK (
    (status = 'registering' AND is_current = true
      AND sealed_material IS NULL AND claim_id IS NOT NULL
      AND lease_expires_at IS NOT NULL AND finished_at IS NULL)
    OR
    (status = 'registered' AND is_current = true
      AND sealed_material IS NOT NULL AND claim_id IS NULL
      AND lease_expires_at IS NULL AND dispatched_at IS NOT NULL
      AND finished_at IS NULL)
    OR
    (status IN ('failed','ambiguous','superseded','expired')
      AND is_current = false AND sealed_material IS NULL
      AND claim_id IS NULL AND lease_expires_at IS NULL
      AND finished_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_client_registrations_current_server_uq
  ON agor_0102_legacy_dcr_expected (tenant_id, mcp_server_id) WHERE is_current = true;
CREATE INDEX mcp_oauth_client_registrations_tenant_server_idx
  ON agor_0102_legacy_dcr_expected (tenant_id, mcp_server_id, registration_generation);
CREATE INDEX mcp_oauth_client_registrations_binding_idx
  ON agor_0102_legacy_dcr_expected (tenant_id, mcp_server_id, binding_fingerprint);
CREATE INDEX mcp_oauth_client_registrations_maintenance_idx
  ON agor_0102_legacy_dcr_expected
  (status, lease_expires_at, client_secret_expires_at, finished_at);
ALTER TABLE agor_0102_legacy_dcr_expected ENABLE ROW LEVEL SECURITY;
ALTER TABLE agor_0102_legacy_dcr_expected FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_mcp_oauth_client_registrations" ON agor_0102_legacy_dcr_expected
  USING (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  )
  WITH CHECK (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  );
CREATE POLICY "mcp_oauth_client_registration_maintenance_select"
  ON agor_0102_legacy_dcr_expected
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
      OR ("status" IN ('failed','ambiguous','superseded','expired')
        AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours')
      OR ("status" IN ('failed','ambiguous','expired')
        AND "sealed_material" IS NULL AND "finished_at" >= CURRENT_TIMESTAMP)
    )
  );
CREATE POLICY "mcp_oauth_client_registration_maintenance_update"
  ON agor_0102_legacy_dcr_expected
  FOR UPDATE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
    )
  )
  WITH CHECK (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','expired')
    AND "is_current" = false AND "sealed_material" IS NULL
    AND "finished_at" >= CURRENT_TIMESTAMP
  );
CREATE POLICY "mcp_oauth_client_registration_maintenance_delete"
  ON agor_0102_legacy_dcr_expected
  FOR DELETE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','superseded','expired')
    AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours'
  );
--> statement-breakpoint
DO $$
DECLARE
  actual regclass := to_regclass('public.mcp_oauth_client_registrations');
  legacy_sequence regclass := to_regclass('public.mcp_oauth_client_registration_generation_seq');
  exact_legacy boolean := false;
BEGIN
  IF actual IS NOT NULL THEN
    exact_legacy :=
      pg_temp.agor_0102_relation_matches(actual, 'pg_temp.agor_0102_legacy_dcr_expected'::regclass)
      AND pg_temp.agor_0102_fk_matches(
        actual, 'mcp_oauth_client_registrations_tenant_server_fk',
        'public.mcp_servers'::regclass, ARRAY['tenant_id','mcp_server_id'],
        ARRAY['tenant_id','mcp_server_id'], true
      )
      AND legacy_sequence IS NOT NULL
      AND pg_temp.agor_0102_sequence_matches(
        legacy_sequence, 'pg_temp.agor_0102_legacy_generation_expected'::regclass
      );
    IF exact_legacy THEN
      DROP TABLE public.mcp_oauth_client_registrations;
      DROP SEQUENCE public.mcp_oauth_client_registration_generation_seq;
    END IF;
  ELSIF legacy_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'unrecognized orphan mcp_oauth_client_registration_generation_seq; refusing automatic reconciliation';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE pg_temp.agor_0102_legacy_dcr_expected;
DROP SEQUENCE pg_temp.agor_0102_legacy_generation_expected;
--> statement-breakpoint
-- Complete final DCR reference.
CREATE TEMP TABLE agor_0102_final_dcr_expected (
  tenant_id text DEFAULT 'default' NOT NULL,
  registration_id varchar(36) CONSTRAINT mcp_oauth_client_registrations_pkey PRIMARY KEY NOT NULL,
  mcp_server_id varchar(36) NOT NULL,
  binding_version integer NOT NULL,
  binding_fingerprint varchar(64) NOT NULL,
  server_config_version integer NOT NULL,
  envelope_version integer NOT NULL,
  is_current boolean DEFAULT true NOT NULL,
  status text DEFAULT 'registering' NOT NULL,
  sealed_material text,
  claim_id varchar(36),
  claim_generation bigint DEFAULT 0 NOT NULL,
  lease_expires_at timestamp with time zone,
  dispatched_at timestamp with time zone,
  client_secret_expires_at timestamp with time zone,
  failure_code text,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  finished_at timestamp with time zone,
  CONSTRAINT mcp_oauth_client_registrations_status_check CHECK (status IN (
    'registering','registered','failed','ambiguous','superseded','expired'
  )),
  CONSTRAINT mcp_oauth_client_registrations_versions_check CHECK (
    binding_version = 1 AND server_config_version > 0
    AND envelope_version > 0 AND claim_generation >= 0
  ),
  CONSTRAINT mcp_oauth_client_registrations_lifecycle_check CHECK (
    (status = 'registering' AND is_current = true
      AND sealed_material IS NULL AND claim_id IS NOT NULL
      AND lease_expires_at IS NOT NULL AND finished_at IS NULL)
    OR
    (status = 'registered' AND is_current = true
      AND sealed_material IS NOT NULL AND claim_id IS NULL
      AND lease_expires_at IS NULL AND dispatched_at IS NOT NULL
      AND finished_at IS NULL)
    OR
    (status IN ('failed','ambiguous','superseded','expired')
      AND is_current = false AND sealed_material IS NULL
      AND claim_id IS NULL AND lease_expires_at IS NULL
      AND finished_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_client_registrations_current_server_uq
  ON agor_0102_final_dcr_expected (tenant_id, mcp_server_id) WHERE is_current = true;
CREATE INDEX mcp_oauth_client_registrations_tenant_server_idx
  ON agor_0102_final_dcr_expected (tenant_id, mcp_server_id, created_at);
CREATE INDEX mcp_oauth_client_registrations_binding_idx
  ON agor_0102_final_dcr_expected (tenant_id, mcp_server_id, binding_fingerprint);
CREATE INDEX mcp_oauth_client_registrations_registering_maintenance_idx
  ON agor_0102_final_dcr_expected (lease_expires_at)
  WHERE status = 'registering' AND is_current = true;
CREATE INDEX mcp_oauth_client_registrations_registered_maintenance_idx
  ON agor_0102_final_dcr_expected (client_secret_expires_at)
  WHERE status = 'registered' AND is_current = true AND client_secret_expires_at IS NOT NULL;
CREATE INDEX mcp_oauth_client_registrations_terminal_maintenance_idx
  ON agor_0102_final_dcr_expected (finished_at)
  WHERE status IN ('failed','ambiguous','superseded','expired');
ALTER TABLE agor_0102_final_dcr_expected ENABLE ROW LEVEL SECURITY;
ALTER TABLE agor_0102_final_dcr_expected FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_mcp_oauth_client_registrations" ON agor_0102_final_dcr_expected
  USING (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  )
  WITH CHECK (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  );
CREATE POLICY "mcp_oauth_client_registration_maintenance_select"
  ON agor_0102_final_dcr_expected
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
      OR ("status" IN ('failed','ambiguous','superseded','expired')
        AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours')
      OR ("status" IN ('failed','ambiguous','expired')
        AND "sealed_material" IS NULL AND "finished_at" >= CURRENT_TIMESTAMP)
    )
  );
CREATE POLICY "mcp_oauth_client_registration_maintenance_update"
  ON agor_0102_final_dcr_expected
  FOR UPDATE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
    )
  )
  WITH CHECK (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','expired')
    AND "is_current" = false AND "sealed_material" IS NULL
    AND "finished_at" >= CURRENT_TIMESTAMP
  );
CREATE POLICY "mcp_oauth_client_registration_maintenance_delete"
  ON agor_0102_final_dcr_expected
  FOR DELETE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','superseded','expired')
    AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours'
  );
--> statement-breakpoint
-- Complete Claude attempt reference.
CREATE TEMP SEQUENCE agor_0102_claude_generation_expected;
CREATE TEMP TABLE agor_0102_claude_expected (
  tenant_id text DEFAULT 'default' NOT NULL,
  attempt_id varchar(36) CONSTRAINT claude_oauth_attempts_pkey PRIMARY KEY NOT NULL,
  state_hash varchar(64) NOT NULL,
  user_id varchar(36) NOT NULL,
  attempt_generation bigint NOT NULL,
  envelope_version integer NOT NULL,
  is_current boolean DEFAULT true NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  sealed_material text,
  exchange_claim_id varchar(36),
  failure_code text,
  subscription_type text,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  exchange_started_at timestamp with time zone,
  finished_at timestamp with time zone
);
CREATE UNIQUE INDEX claude_oauth_attempts_state_hash_unique
  ON agor_0102_claude_expected (state_hash);
CREATE INDEX claude_oauth_attempts_tenant_user_idx
  ON agor_0102_claude_expected (tenant_id, user_id, created_at);
CREATE UNIQUE INDEX claude_oauth_attempts_current_user_uq
  ON agor_0102_claude_expected (tenant_id, user_id) WHERE is_current = true;
CREATE INDEX claude_oauth_attempts_maintenance_idx
  ON agor_0102_claude_expected (status, expires_at, exchange_started_at, finished_at);
ALTER TABLE agor_0102_claude_expected ENABLE ROW LEVEL SECURITY;
ALTER TABLE agor_0102_claude_expected FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_claude_oauth_attempts" ON agor_0102_claude_expected
	USING (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
	)
	WITH CHECK (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
	);
-- Every daemon may age due attempts and delete old terminal tombstones. The
-- policy exposes only rows that are already due for that exact maintenance,
-- plus expired/ambiguous rows produced at this transaction's database time.
-- PostgreSQL applies SELECT RLS to an UPDATE's new row even without RETURNING,
-- so that second, self-expiring arm is required for the maintenance transition.
CREATE POLICY "claude_oauth_maintenance_select" ON agor_0102_claude_expected
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" IN ('exchanging', 'persisting') AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
			OR ("status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
				AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours')
			OR ("status" IN ('ambiguous', 'expired')
				AND "sealed_material" IS NULL
				AND "finished_at" = CURRENT_TIMESTAMP)
		)
	);
CREATE POLICY "claude_oauth_maintenance_update" ON agor_0102_claude_expected
	FOR UPDATE
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" IN ('exchanging', 'persisting') AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
		)
	)
	WITH CHECK (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND "status" IN ('expired', 'ambiguous')
		AND "sealed_material" IS NULL
	);
CREATE POLICY "claude_oauth_maintenance_delete" ON agor_0102_claude_expected
	FOR DELETE
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND "status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
		AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
	);
--> statement-breakpoint
DO $$
DECLARE
  dcr regclass := to_regclass('public.mcp_oauth_client_registrations');
  claude regclass := to_regclass('public.claude_oauth_attempts');
  legacy_sequence regclass := to_regclass('public.mcp_oauth_client_registration_generation_seq');
  claude_sequence regclass := to_regclass('public.claude_oauth_attempt_generation_seq');
BEGIN
  IF dcr IS NOT NULL AND NOT (
    legacy_sequence IS NULL
    AND pg_temp.agor_0102_relation_matches(dcr, 'pg_temp.agor_0102_final_dcr_expected'::regclass)
    AND pg_temp.agor_0102_fk_matches(
      dcr, 'mcp_oauth_client_registrations_tenant_server_fk',
      'public.mcp_servers'::regclass, ARRAY['tenant_id','mcp_server_id'],
      ARRAY['tenant_id','mcp_server_id'], true
    )
  ) THEN
    RAISE EXCEPTION 'unrecognized mcp_oauth_client_registrations schema; refusing automatic reconciliation';
  END IF;
  IF dcr IS NULL AND legacy_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'unrecognized orphan mcp_oauth_client_registration_generation_seq; refusing automatic reconciliation';
  END IF;

  IF claude IS NOT NULL AND NOT (
    claude_sequence IS NOT NULL
    AND pg_temp.agor_0102_sequence_matches(
      claude_sequence, 'pg_temp.agor_0102_claude_generation_expected'::regclass
    )
    AND pg_temp.agor_0102_relation_matches(claude, 'pg_temp.agor_0102_claude_expected'::regclass)
    AND pg_temp.agor_0102_fk_matches(
      claude, 'claude_oauth_attempts_tenant_user_fk', 'public.users'::regclass,
      ARRAY['tenant_id','user_id'], ARRAY['tenant_id','user_id'], false
    )
  ) THEN
    RAISE EXCEPTION 'unrecognized claude_oauth_attempts schema; refusing automatic reconciliation';
  END IF;
  IF claude IS NULL AND claude_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'unrecognized orphan claude_oauth_attempt_generation_seq; refusing automatic reconciliation';
  END IF;
END $$;
-- Durable authority for Claude subscription OAuth sign-in attempts. The raw
-- OAuth state, the authorization code, and the resulting access and refresh
-- tokens are deliberately absent. state_hash is SHA-256 over the high-entropy
-- one-time state; the PKCE verifier is stored only inside sealed_material.
-- Unlike mcp_oauth_pending_flows there is no unauthenticated provider callback
-- — the user pastes the code back into an authenticated session — so this table
-- gets no state-hash capability policy and no agor.oauth_state_hash binding.
CREATE TABLE IF NOT EXISTS "claude_oauth_attempts" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"attempt_id" varchar(36) PRIMARY KEY NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"attempt_generation" bigint NOT NULL,
	"envelope_version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sealed_material" text,
	"exchange_claim_id" varchar(36),
	"failure_code" text,
	"subscription_type" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchange_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "claude_oauth_attempts_tenant_user_fk"
		FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."users"("tenant_id", "user_id")
		ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "claude_oauth_attempt_generation_seq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claude_oauth_attempts_state_hash_unique"
	ON "claude_oauth_attempts" ("state_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claude_oauth_attempts_tenant_user_idx"
	ON "claude_oauth_attempts" ("tenant_id", "user_id", "created_at");
--> statement-breakpoint
-- The durable replacement for the process-local "one in-flight attempt per
-- user" Map invariant: at most one live attempt row can exist per tenant user.
CREATE UNIQUE INDEX IF NOT EXISTS "claude_oauth_attempts_current_user_uq"
	ON "claude_oauth_attempts" ("tenant_id", "user_id")
	WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claude_oauth_attempts_maintenance_idx"
	ON "claude_oauth_attempts" ("status", "expires_at", "exchange_started_at", "finished_at");
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_claude_oauth_attempts" ON "claude_oauth_attempts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_claude_oauth_attempts" ON "claude_oauth_attempts"
	USING (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
	)
	WITH CHECK (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
	);
--> statement-breakpoint
-- Every daemon may age due attempts and delete old terminal tombstones. The
-- policy exposes only rows that are already due for that exact maintenance,
-- plus expired/ambiguous rows produced at this transaction's database time.
-- PostgreSQL applies SELECT RLS to an UPDATE's new row even without RETURNING,
-- so that second, self-expiring arm is required for the maintenance transition.
DROP POLICY IF EXISTS "claude_oauth_maintenance_select" ON "claude_oauth_attempts";
--> statement-breakpoint
CREATE POLICY "claude_oauth_maintenance_select" ON "claude_oauth_attempts"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" IN ('exchanging', 'persisting') AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
			OR ("status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
				AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours')
			OR ("status" IN ('ambiguous', 'expired')
				AND "sealed_material" IS NULL
				AND "finished_at" = CURRENT_TIMESTAMP)
		)
	);
--> statement-breakpoint
DROP POLICY IF EXISTS "claude_oauth_maintenance_update" ON "claude_oauth_attempts";
--> statement-breakpoint
CREATE POLICY "claude_oauth_maintenance_update" ON "claude_oauth_attempts"
	FOR UPDATE
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" IN ('exchanging', 'persisting') AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
		)
	)
	WITH CHECK (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND "status" IN ('expired', 'ambiguous')
		AND "sealed_material" IS NULL
	);
--> statement-breakpoint
DROP POLICY IF EXISTS "claude_oauth_maintenance_delete" ON "claude_oauth_attempts";
--> statement-breakpoint
CREATE POLICY "claude_oauth_maintenance_delete" ON "claude_oauth_attempts"
	FOR DELETE
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND "status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
		AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
	);
--> statement-breakpoint
-- Fleet-wide, tenant-bound Dynamic Client Registration authority.
CREATE TABLE IF NOT EXISTS "mcp_oauth_client_registrations" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "registration_id" varchar(36) PRIMARY KEY NOT NULL,
  "mcp_server_id" varchar(36) NOT NULL,
  "binding_version" integer NOT NULL,
  "binding_fingerprint" varchar(64) NOT NULL,
  "server_config_version" integer NOT NULL,
  "envelope_version" integer NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'registering' NOT NULL,
  "sealed_material" text,
  "claim_id" varchar(36),
  "claim_generation" bigint DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  "client_secret_expires_at" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "mcp_oauth_client_registrations_tenant_server_fk"
    FOREIGN KEY ("tenant_id", "mcp_server_id")
    REFERENCES "public"."mcp_servers"("tenant_id", "mcp_server_id")
    ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "mcp_oauth_client_registrations_status_check" CHECK ("status" IN (
    'registering','registered','failed','ambiguous','superseded','expired'
  )),
  CONSTRAINT "mcp_oauth_client_registrations_versions_check" CHECK (
    "binding_version" = 1 AND "server_config_version" > 0
    AND "envelope_version" > 0
    AND "claim_generation" >= 0
  ),
  CONSTRAINT "mcp_oauth_client_registrations_lifecycle_check" CHECK (
    ("status" = 'registering' AND "is_current" = true
      AND "sealed_material" IS NULL AND "claim_id" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL AND "finished_at" IS NULL)
    OR
    ("status" = 'registered' AND "is_current" = true
      AND "sealed_material" IS NOT NULL AND "claim_id" IS NULL
      AND "lease_expires_at" IS NULL AND "dispatched_at" IS NOT NULL
      AND "finished_at" IS NULL)
    OR
    ("status" IN ('failed','ambiguous','superseded','expired')
      AND "is_current" = false AND "sealed_material" IS NULL
      AND "claim_id" IS NULL AND "lease_expires_at" IS NULL
      AND "finished_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_current_server_uq"
  ON "mcp_oauth_client_registrations" ("tenant_id", "mcp_server_id")
  WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_tenant_server_idx"
  ON "mcp_oauth_client_registrations"
  ("tenant_id", "mcp_server_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_binding_idx"
  ON "mcp_oauth_client_registrations"
  ("tenant_id", "mcp_server_id", "binding_fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_registering_maintenance_idx"
  ON "mcp_oauth_client_registrations" ("lease_expires_at")
  WHERE "status" = 'registering' AND "is_current" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_registered_maintenance_idx"
  ON "mcp_oauth_client_registrations" ("client_secret_expires_at")
  WHERE "status" = 'registered' AND "is_current" = true
    AND "client_secret_expires_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_terminal_maintenance_idx"
  ON "mcp_oauth_client_registrations" ("finished_at")
  WHERE "status" IN ('failed','ambiguous','superseded','expired');
--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_registrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_registrations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_mcp_oauth_client_registrations" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_mcp_oauth_client_registrations" ON "mcp_oauth_client_registrations"
  USING (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  )
  WITH CHECK (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_client_registration_maintenance_select" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_registration_maintenance_select"
  ON "mcp_oauth_client_registrations"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
      OR ("status" IN ('failed','ambiguous','superseded','expired')
        AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours')
      OR ("status" IN ('failed','ambiguous','expired')
        AND "sealed_material" IS NULL AND "finished_at" >= CURRENT_TIMESTAMP)
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_client_registration_maintenance_update" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_registration_maintenance_update"
  ON "mcp_oauth_client_registrations"
  FOR UPDATE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
    )
  )
  WITH CHECK (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','expired')
    AND "is_current" = false AND "sealed_material" IS NULL
    AND "finished_at" >= CURRENT_TIMESTAMP
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_client_registration_maintenance_delete" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_registration_maintenance_delete"
  ON "mcp_oauth_client_registrations"
  FOR DELETE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','superseded','expired')
    AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours'
  );
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT (
    pg_temp.agor_0102_relation_matches(
      'public.mcp_oauth_client_registrations'::regclass,
      'pg_temp.agor_0102_final_dcr_expected'::regclass
    )
    AND pg_temp.agor_0102_fk_matches(
      'public.mcp_oauth_client_registrations'::regclass,
      'mcp_oauth_client_registrations_tenant_server_fk',
      'public.mcp_servers'::regclass, ARRAY['tenant_id','mcp_server_id'],
      ARRAY['tenant_id','mcp_server_id'], true
    )
    AND to_regclass('public.mcp_oauth_client_registration_generation_seq') IS NULL
  ) THEN
    RAISE EXCEPTION 'final mcp_oauth_client_registrations schema fingerprint mismatch';
  END IF;
  IF NOT (
    pg_temp.agor_0102_relation_matches(
      'public.claude_oauth_attempts'::regclass,
      'pg_temp.agor_0102_claude_expected'::regclass
    )
    AND pg_temp.agor_0102_fk_matches(
      'public.claude_oauth_attempts'::regclass,
      'claude_oauth_attempts_tenant_user_fk', 'public.users'::regclass,
      ARRAY['tenant_id','user_id'], ARRAY['tenant_id','user_id'], false
    )
    AND pg_temp.agor_0102_sequence_matches(
      'public.claude_oauth_attempt_generation_seq'::regclass,
      'pg_temp.agor_0102_claude_generation_expected'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'final claude_oauth_attempts schema fingerprint mismatch';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE pg_temp.agor_0102_final_dcr_expected;
DROP TABLE pg_temp.agor_0102_claude_expected;
DROP SEQUENCE pg_temp.agor_0102_claude_generation_expected;
DROP FUNCTION pg_temp.agor_0102_sequence_matches(regclass, regclass);
DROP FUNCTION pg_temp.agor_0102_fk_matches(regclass, text, regclass, text[], text[], boolean);
DROP FUNCTION pg_temp.agor_0102_relation_matches(regclass, regclass);
DROP FUNCTION pg_temp.agor_0102_relation_fingerprint(regclass);
DROP FUNCTION pg_temp.agor_0102_norm(text);
