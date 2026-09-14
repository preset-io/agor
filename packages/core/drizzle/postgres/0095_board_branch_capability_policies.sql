SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Drop FORCE RLS so the owning migrate role sees every tenant during the
-- cross-tenant backfill/normalization below; without this the statements run
-- against only the 'default' tenant and SET NOT NULL fails. Restored at the end.
ALTER TABLE "boards" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branches" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_owners" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_owners" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_group_grants" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_group_grants" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Offline/big-bang RBAC remodel. No runtime dual-read/dual-write bridge is retained.
ALTER TABLE "boards" ADD COLUMN "primary_owner_user_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "primary_owner_user_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "permission_binding" text DEFAULT 'override' NOT NULL
  CONSTRAINT "branches_permission_binding_check" CHECK ("permission_binding" IN ('inherit','override'));
--> statement-breakpoint
UPDATE "boards" b SET "primary_owner_user_id" = COALESCE(
  (SELECT bo.user_id FROM board_owners bo JOIN users u ON u.tenant_id=bo.tenant_id AND u.user_id=bo.user_id
   WHERE bo.tenant_id=b.tenant_id AND bo.board_id=b.board_id
   ORDER BY bo.created_at NULLS LAST,bo.user_id LIMIT 1),
  (SELECT u.user_id FROM users u WHERE u.tenant_id=b.tenant_id AND u.user_id=b.created_by)
);
--> statement-breakpoint
UPDATE "branches" br SET "primary_owner_user_id" = COALESCE(
  (SELECT bo.user_id FROM branch_owners bo JOIN users u ON u.tenant_id=bo.tenant_id AND u.user_id=bo.user_id
   WHERE bo.tenant_id=br.tenant_id AND bo.branch_id=br.branch_id
   ORDER BY bo.created_at NULLS LAST,bo.user_id LIMIT 1),
  (SELECT u.user_id FROM users u WHERE u.tenant_id=br.tenant_id AND u.user_id=br.created_by)
);
--> statement-breakpoint
DO $$
DECLARE failures text;
BEGIN
  SELECT string_agg(kind||':'||id, ', ' ORDER BY kind,id) INTO failures FROM (
    SELECT 'board' kind, board_id id FROM boards WHERE primary_owner_user_id IS NULL
    UNION ALL SELECT 'branch', branch_id FROM branches WHERE primary_owner_user_id IS NULL
  ) missing;
  IF failures IS NOT NULL THEN RAISE EXCEPTION 'RBAC migration cannot attribute primary owners: %', failures; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "primary_owner_user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "primary_owner_user_id" SET NOT NULL;
--> statement-breakpoint
-- Keep inheritance only when the board package already represents every old
-- source of authority. Branch-specific owners/groups and a different board
-- owner require a materialized override so directly representable grants are
-- not discarded by the cutover.
UPDATE "branches" br SET "permission_binding"=CASE
 WHEN br."permission_source"='board' AND br."board_id" IS NOT NULL
  AND br."primary_owner_user_id"=(SELECT b."primary_owner_user_id" FROM "boards" b WHERE b."tenant_id"=br."tenant_id" AND b."board_id"=br."board_id")
  AND NOT EXISTS(SELECT 1 FROM "branch_owners" bo WHERE bo."tenant_id"=br."tenant_id" AND bo."branch_id"=br."branch_id" AND bo."user_id"<>br."primary_owner_user_id")
  AND NOT EXISTS(SELECT 1 FROM "branch_group_grants" bg WHERE bg."tenant_id"=br."tenant_id" AND bg."branch_id"=br."branch_id" AND bg."can"<>'none')
 THEN 'inherit' ELSE 'override' END;
--> statement-breakpoint

-- Composite identities let every normalized FK prove that its parent and
-- principal belong to the same tenant. IDs remain globally unique for API
-- compatibility, but RLS is not the only tenant-isolation boundary.
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_user_id_unique" ON "users" ("tenant_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "groups_tenant_group_id_unique" ON "groups" ("tenant_id","group_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "boards_tenant_board_id_unique" ON "boards" ("tenant_id","board_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_tenant_branch_id_unique" ON "branches" ("tenant_id","branch_id");
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_tenant_primary_owner_fk"
  FOREIGN KEY ("tenant_id","primary_owner_user_id") REFERENCES "users"("tenant_id","user_id") ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_primary_owner_fk"
  FOREIGN KEY ("tenant_id","primary_owner_user_id") REFERENCES "users"("tenant_id","user_id") ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint

CREATE TABLE "board_access_policies" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "board_id" varchar(36) PRIMARY KEY NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "sharing_mode" text NOT NULL CONSTRAINT "board_access_policies_sharing_mode_check" CHECK ("sharing_mode" IN ('private','shared')),
  "others_role" text DEFAULT 'none' NOT NULL CONSTRAINT "board_access_policies_others_role_check" CHECK ("others_role" IN ('none','viewer','editor','manager')),
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_by" varchar(36),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "board_access_policies_tenant_board_fk" FOREIGN KEY ("tenant_id","board_id") REFERENCES "boards"("tenant_id","board_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "board_access_policies_updated_by_users_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("user_id") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "board_access_policies_tenant_id_idx" ON "board_access_policies" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "board_access_policies_tenant_board_unique" ON "board_access_policies" ("tenant_id","board_id");
--> statement-breakpoint
CREATE INDEX "board_access_policies_updated_idx" ON "board_access_policies" ("updated_at");
--> statement-breakpoint
CREATE TABLE "board_access_entries" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "entry_id" varchar(36) PRIMARY KEY NOT NULL,
  "board_id" varchar(36) NOT NULL,
  "user_id" varchar(36), "group_id" varchar(36), "role" text NOT NULL CONSTRAINT "board_access_entries_role_check" CHECK ("role" IN ('none','viewer','editor','manager')),
  "created_at" timestamp with time zone NOT NULL, "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "board_access_entries_principal_check" CHECK (("user_id" IS NOT NULL) <> ("group_id" IS NOT NULL)),
  CONSTRAINT "board_access_entries_tenant_board_fk" FOREIGN KEY ("tenant_id","board_id") REFERENCES "board_access_policies"("tenant_id","board_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "board_access_entries_tenant_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","user_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "board_access_entries_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "groups"("tenant_id","group_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "board_access_entries_tenant_id_idx" ON "board_access_entries" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "board_access_entries_board_idx" ON "board_access_entries" ("board_id");
--> statement-breakpoint
CREATE INDEX "board_access_entries_user_idx" ON "board_access_entries" ("tenant_id","user_id","board_id");
--> statement-breakpoint
CREATE INDEX "board_access_entries_group_idx" ON "board_access_entries" ("tenant_id","group_id","board_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "board_access_entries_board_user_unique" ON "board_access_entries" ("tenant_id","board_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "board_access_entries_board_group_unique" ON "board_access_entries" ("tenant_id","board_id","group_id");
--> statement-breakpoint

CREATE TABLE "branch_permission_configs" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "config_id" varchar(36) PRIMARY KEY NOT NULL,
  "board_id" varchar(36), "branch_id" varchar(36), "schema_version" integer DEFAULT 1 NOT NULL,
  "sharing_mode" text NOT NULL CONSTRAINT "branch_permission_configs_sharing_mode_check" CHECK ("sharing_mode" IN ('private','shared')), "others_role" text DEFAULT 'none' NOT NULL CONSTRAINT "branch_permission_configs_others_role_check" CHECK ("others_role" IN ('none','viewer','collaborator','manager')),
  "others_fs_access" text DEFAULT 'none' NOT NULL CONSTRAINT "branch_permission_configs_others_fs_access_check" CHECK ("others_fs_access" IN ('none','read','write')),
  "revision" integer DEFAULT 1 NOT NULL, "updated_by" varchar(36),
  "created_at" timestamp with time zone NOT NULL, "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "branch_permission_configs_target_check" CHECK (("board_id" IS NOT NULL) <> ("branch_id" IS NOT NULL)),
  CONSTRAINT "branch_permission_configs_tenant_board_fk" FOREIGN KEY ("tenant_id","board_id") REFERENCES "boards"("tenant_id","board_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "branch_permission_configs_tenant_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "branches"("tenant_id","branch_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "branch_permission_configs_updated_by_users_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("user_id") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "branch_permission_configs_tenant_id_idx" ON "branch_permission_configs" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_permission_configs_tenant_config_unique" ON "branch_permission_configs" ("tenant_id","config_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_permission_configs_board_unique" ON "branch_permission_configs" ("tenant_id","board_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_permission_configs_branch_unique" ON "branch_permission_configs" ("tenant_id","branch_id");
--> statement-breakpoint
CREATE INDEX "branch_permission_configs_updated_idx" ON "branch_permission_configs" ("updated_at");
--> statement-breakpoint
CREATE TABLE "branch_permission_entries" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "entry_id" varchar(36) PRIMARY KEY NOT NULL, "config_id" varchar(36) NOT NULL,
  "user_id" varchar(36), "group_id" varchar(36), "role" text NOT NULL CONSTRAINT "branch_permission_entries_role_check" CHECK ("role" IN ('none','viewer','collaborator','manager')),
  "fs_access" text DEFAULT 'none' NOT NULL CONSTRAINT "branch_permission_entries_fs_access_check" CHECK ("fs_access" IN ('none','read','write')),
  "created_at" timestamp with time zone NOT NULL, "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "branch_permission_entries_principal_check" CHECK (("user_id" IS NOT NULL) <> ("group_id" IS NOT NULL)),
  CONSTRAINT "branch_permission_entries_tenant_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "branch_permission_configs"("tenant_id","config_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "branch_permission_entries_tenant_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","user_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "branch_permission_entries_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "groups"("tenant_id","group_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "branch_permission_entries_tenant_id_idx" ON "branch_permission_entries" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "branch_permission_entries_config_idx" ON "branch_permission_entries" ("config_id");
--> statement-breakpoint
CREATE INDEX "branch_permission_entries_user_idx" ON "branch_permission_entries" ("tenant_id","user_id","config_id");
--> statement-breakpoint
CREATE INDEX "branch_permission_entries_group_idx" ON "branch_permission_entries" ("tenant_id","group_id","config_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_permission_entries_config_user_unique" ON "branch_permission_entries" ("tenant_id","config_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_permission_entries_config_group_unique" ON "branch_permission_entries" ("tenant_id","config_id","group_id");
--> statement-breakpoint
CREATE TABLE "branch_session_sharing_rules" (
  "tenant_id" text DEFAULT 'default' NOT NULL, "config_id" varchar(36) NOT NULL,
  "session_owner_user_id" varchar(36) NOT NULL, "enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone NOT NULL, PRIMARY KEY ("tenant_id","config_id","session_owner_user_id"),
  CONSTRAINT "branch_session_sharing_rules_tenant_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "branch_permission_configs"("tenant_id","config_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "branch_session_sharing_rules_tenant_owner_fk" FOREIGN KEY ("tenant_id","session_owner_user_id") REFERENCES "users"("tenant_id","user_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "branch_session_sharing_rules_tenant_id_idx" ON "branch_session_sharing_rules" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "branch_session_sharing_rules_owner_idx" ON "branch_session_sharing_rules" ("session_owner_user_id");
--> statement-breakpoint
CREATE TABLE "branch_session_sharing_grants" (
  "tenant_id" text DEFAULT 'default' NOT NULL, "grant_id" varchar(36) PRIMARY KEY NOT NULL,
  "config_id" varchar(36) NOT NULL, "session_owner_user_id" varchar(36) NOT NULL,
  "user_id" varchar(36), "group_id" varchar(36), "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "branch_session_sharing_grants_principal_check" CHECK (("user_id" IS NOT NULL) <> ("group_id" IS NOT NULL)),
  CONSTRAINT "branch_session_sharing_grants_tenant_rule_fk" FOREIGN KEY ("tenant_id","config_id","session_owner_user_id") REFERENCES "branch_session_sharing_rules"("tenant_id","config_id","session_owner_user_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "branch_session_sharing_grants_tenant_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","user_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "branch_session_sharing_grants_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "groups"("tenant_id","group_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "branch_session_sharing_grants_tenant_id_idx" ON "branch_session_sharing_grants" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "branch_session_sharing_grants_rule_idx" ON "branch_session_sharing_grants" ("config_id","session_owner_user_id");
--> statement-breakpoint
CREATE INDEX "branch_session_sharing_grants_user_idx" ON "branch_session_sharing_grants" ("tenant_id","user_id","config_id");
--> statement-breakpoint
CREATE INDEX "branch_session_sharing_grants_group_idx" ON "branch_session_sharing_grants" ("tenant_id","group_id","config_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_session_sharing_grants_rule_user_unique" ON "branch_session_sharing_grants" ("tenant_id","config_id","session_owner_user_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_session_sharing_grants_rule_group_unique" ON "branch_session_sharing_grants" ("tenant_id","config_id","session_owner_user_id","group_id");
--> statement-breakpoint

INSERT INTO board_access_policies
SELECT b.tenant_id,b.board_id,1,
 CASE WHEN COALESCE(b.data->>'access_mode','shared')='shared'
   OR EXISTS(SELECT 1 FROM board_owners bo WHERE bo.tenant_id=b.tenant_id AND bo.board_id=b.board_id AND bo.user_id<>b.primary_owner_user_id)
   OR EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=b.tenant_id AND u.user_id=b.created_by AND b.created_by<>b.primary_owner_user_id)
   THEN 'shared' ELSE 'private' END,
 CASE WHEN COALESCE(b.data->>'access_mode','shared')='shared' THEN 'viewer' ELSE 'none' END,
 1,b.primary_owner_user_id,COALESCE(b.created_at,now()),COALESCE(b.updated_at,b.created_at,now()) FROM boards b;
--> statement-breakpoint
INSERT INTO board_access_entries
SELECT bo.tenant_id,gen_random_uuid()::text,bo.board_id,bo.user_id,NULL,'manager',COALESCE(bo.created_at,now()),COALESCE(bo.created_at,now())
FROM board_owners bo JOIN boards b ON b.tenant_id=bo.tenant_id AND b.board_id=bo.board_id WHERE bo.user_id<>b.primary_owner_user_id;
--> statement-breakpoint
-- Legacy board visibility always included a valid creator independently of
-- the mutable owner table. Preserve that authority as Manager without making
-- a removed creator the immutable primary owner.
INSERT INTO board_access_entries
SELECT b.tenant_id,gen_random_uuid()::text,b.board_id,b.created_by,NULL,'manager',
 COALESCE(b.created_at,now()),COALESCE(b.updated_at,b.created_at,now())
FROM boards b JOIN users u ON u.tenant_id=b.tenant_id AND u.user_id=b.created_by
WHERE b.created_by<>b.primary_owner_user_id
ON CONFLICT (tenant_id,board_id,user_id) DO UPDATE SET role='manager',updated_at=EXCLUDED.updated_at;
--> statement-breakpoint
INSERT INTO board_access_entries
SELECT bg.tenant_id,gen_random_uuid()::text,bg.board_id,NULL,bg.group_id,CASE bg.can WHEN 'all' THEN 'manager' ELSE 'viewer' END,
 COALESCE(bg.created_at,now()),COALESCE(bg.updated_at,bg.created_at,now())
FROM board_group_grants bg JOIN boards b ON b.tenant_id=bg.tenant_id AND b.board_id=bg.board_id
WHERE bg.can<>'none' AND COALESCE(b.data->>'access_mode','shared')='shared';
--> statement-breakpoint

INSERT INTO branch_permission_configs
SELECT b.tenant_id,gen_random_uuid()::text,b.board_id,NULL,1,
 CASE WHEN COALESCE(b.data->>'access_mode','shared')='shared'
            AND (COALESCE(b.data->>'default_others_can','session')<>'none'
                 OR EXISTS(SELECT 1 FROM board_group_grants bg WHERE bg.tenant_id=b.tenant_id AND bg.board_id=b.board_id AND bg.can<>'none'))
   OR EXISTS(SELECT 1 FROM board_owners bo WHERE bo.tenant_id=b.tenant_id AND bo.board_id=b.board_id AND bo.user_id<>b.primary_owner_user_id)
   THEN 'shared' ELSE 'private' END,
 CASE WHEN COALESCE(b.data->>'access_mode','shared')='private' THEN 'none'
      ELSE CASE COALESCE(b.data->>'default_others_can','session') WHEN 'none' THEN 'none' WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END END,
 CASE WHEN COALESCE(b.data->>'access_mode','shared')='private' OR COALESCE(b.data->>'default_others_can','session')='none'
      THEN 'none' ELSE COALESCE(b.data->>'default_others_fs_access','read') END,
 1,b.primary_owner_user_id,COALESCE(b.created_at,now()),COALESCE(b.updated_at,b.created_at,now()) FROM boards b;
--> statement-breakpoint
INSERT INTO branch_permission_entries
SELECT bo.tenant_id,gen_random_uuid()::text,c.config_id,bo.user_id,NULL,'manager','write',COALESCE(bo.created_at,now()),COALESCE(bo.created_at,now())
FROM board_owners bo JOIN boards b ON b.tenant_id=bo.tenant_id AND b.board_id=bo.board_id JOIN branch_permission_configs c ON c.tenant_id=bo.tenant_id AND c.board_id=bo.board_id WHERE bo.user_id<>b.primary_owner_user_id;
--> statement-breakpoint
INSERT INTO branch_permission_entries
SELECT bg.tenant_id,gen_random_uuid()::text,c.config_id,NULL,bg.group_id,CASE bg.can WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END,
 COALESCE(bg.fs_access,'read'),COALESCE(bg.created_at,now()),COALESCE(bg.updated_at,bg.created_at,now())
FROM board_group_grants bg JOIN boards b ON b.tenant_id=bg.tenant_id AND b.board_id=bg.board_id JOIN branch_permission_configs c ON c.tenant_id=bg.tenant_id AND c.board_id=bg.board_id
WHERE bg.can<>'none' AND COALESCE(b.data->>'access_mode','shared')='shared';
--> statement-breakpoint

-- A branch may carry a stale permission_source='board' while its board_id is
-- NULL or dangling (the board was deleted). The board_config LEFT JOIN is then
-- unmatched, so inheriting its others_role/others_fs_access would insert NULL
-- into NOT NULL columns. Guard every board-inheritance branch on a resolved
-- board_config and otherwise fall back to the branch's own others_can/fs, the
-- same path used for genuine 'override' branches.
INSERT INTO branch_permission_configs
SELECT br.tenant_id,gen_random_uuid()::text,NULL,br.branch_id,1,
 CASE WHEN br.permission_source='board' AND board_config.config_id IS NOT NULL THEN 'shared'
  WHEN COALESCE(br.others_can,'session')<>'none' OR EXISTS(SELECT 1 FROM branch_owners bo WHERE bo.tenant_id=br.tenant_id AND bo.branch_id=br.branch_id AND bo.user_id<>br.primary_owner_user_id) OR EXISTS(SELECT 1 FROM branch_group_grants bg WHERE bg.tenant_id=br.tenant_id AND bg.branch_id=br.branch_id AND bg.can<>'none') THEN 'shared' ELSE 'private' END,
 CASE WHEN br.permission_source='board' AND board_config.config_id IS NOT NULL THEN board_config.others_role ELSE CASE COALESCE(br.others_can,'session') WHEN 'none' THEN 'none' WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END END,
 CASE WHEN br.permission_source='board' AND board_config.config_id IS NOT NULL THEN board_config.others_fs_access WHEN COALESCE(br.others_can,'session')='none' THEN 'none' ELSE COALESCE(br.others_fs_access,'read') END,
 1,br.primary_owner_user_id,COALESCE(br.created_at,now()),COALESCE(br.updated_at,br.created_at,now())
FROM branches br
LEFT JOIN branch_permission_configs board_config ON board_config.tenant_id=br.tenant_id AND board_config.board_id=br.board_id
WHERE br.permission_binding='override';
--> statement-breakpoint
-- Copy named board-template entries into materialized board-derived overrides.
INSERT INTO branch_permission_entries
SELECT br.tenant_id,gen_random_uuid()::text,target.config_id,source_entry.user_id,source_entry.group_id,
 source_entry.role,source_entry.fs_access,source_entry.created_at,source_entry.updated_at
FROM branches br
JOIN branch_permission_configs target ON target.tenant_id=br.tenant_id AND target.branch_id=br.branch_id
JOIN branch_permission_configs source ON source.tenant_id=br.tenant_id AND source.board_id=br.board_id
JOIN branch_permission_entries source_entry ON source_entry.tenant_id=source.tenant_id AND source_entry.config_id=source.config_id
WHERE br.permission_source='board'
 AND (source_entry.user_id IS NULL OR source_entry.user_id<>br.primary_owner_user_id);
--> statement-breakpoint
-- A board owner was an implicit branch owner under the old board-aligned
-- resolver. Preserve that Manager grant when the branch has another owner.
INSERT INTO branch_permission_entries
SELECT br.tenant_id,gen_random_uuid()::text,target.config_id,b.primary_owner_user_id,NULL,
 'manager','write',COALESCE(b.created_at,now()),COALESCE(b.updated_at,b.created_at,now())
FROM branches br
JOIN boards b ON b.tenant_id=br.tenant_id AND b.board_id=br.board_id
JOIN branch_permission_configs target ON target.tenant_id=br.tenant_id AND target.branch_id=br.branch_id
WHERE br.permission_source='board' AND b.primary_owner_user_id<>br.primary_owner_user_id
ON CONFLICT (tenant_id,config_id,user_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO branch_permission_entries
SELECT bo.tenant_id,gen_random_uuid()::text,c.config_id,bo.user_id,NULL,'manager','write',COALESCE(bo.created_at,now()),COALESCE(bo.created_at,now())
FROM branch_owners bo JOIN branches br ON br.tenant_id=bo.tenant_id AND br.branch_id=bo.branch_id JOIN branch_permission_configs c ON c.tenant_id=bo.tenant_id AND c.branch_id=bo.branch_id WHERE bo.user_id<>br.primary_owner_user_id
ON CONFLICT (tenant_id,config_id,user_id) DO UPDATE SET role='manager',fs_access='write',updated_at=EXCLUDED.updated_at;
--> statement-breakpoint
INSERT INTO branch_permission_entries
SELECT bg.tenant_id,gen_random_uuid()::text,c.config_id,NULL,bg.group_id,CASE bg.can WHEN 'view' THEN 'viewer' WHEN 'all' THEN 'manager' ELSE 'collaborator' END,
 COALESCE(bg.fs_access,'read'),COALESCE(bg.created_at,now()),COALESCE(bg.updated_at,bg.created_at,now())
FROM branch_group_grants bg JOIN branch_permission_configs c ON c.tenant_id=bg.tenant_id AND c.branch_id=bg.branch_id WHERE bg.can<>'none'
ON CONFLICT (tenant_id,config_id,group_id) DO UPDATE SET
 role=CASE
  WHEN EXCLUDED.role='manager' OR branch_permission_entries.role='manager' THEN 'manager'
  WHEN EXCLUDED.role='collaborator' OR branch_permission_entries.role='collaborator' THEN 'collaborator'
  ELSE 'viewer' END,
 fs_access=CASE
  WHEN EXCLUDED.fs_access='write' OR branch_permission_entries.fs_access='write' THEN 'write'
  WHEN EXCLUDED.fs_access='read' OR branch_permission_entries.fs_access='read' THEN 'read'
  ELSE 'none' END,
 updated_at=EXCLUDED.updated_at;
--> statement-breakpoint

DELETE FROM branch_owners;
--> statement-breakpoint
DELETE FROM board_owners;
--> statement-breakpoint
DELETE FROM branch_group_grants;
--> statement-breakpoint
DELETE FROM board_group_grants;
--> statement-breakpoint
UPDATE branches SET permission_source='override',others_can='none',others_fs_access='none',
 data=(data-'dangerously_allow_session_sharing')||'{"dangerously_allow_session_sharing":false}'::jsonb;
--> statement-breakpoint
UPDATE boards SET data=(data-'access_mode'-'default_others_can'-'default_others_fs_access'-'default_dangerously_allow_session_sharing')||
 '{"access_mode":"private","default_others_can":"none","default_others_fs_access":"none","default_dangerously_allow_session_sharing":false}'::jsonb;
--> statement-breakpoint

CREATE FUNCTION agor_reject_primary_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.primary_owner_user_id IS DISTINCT FROM OLD.primary_owner_user_id THEN RAISE EXCEPTION 'primary owner is immutable'; END IF; RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER boards_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON boards FOR EACH ROW EXECUTE FUNCTION agor_reject_primary_owner_change();
--> statement-breakpoint
CREATE TRIGGER branches_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON branches FOR EACH ROW EXECUTE FUNCTION agor_reject_primary_owner_change();
--> statement-breakpoint

-- Every normalized policy table is tenant-owned and forced through the same RLS boundary.
ALTER TABLE board_access_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE board_access_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_board_access_policies" ON "board_access_policies" USING (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default')) WITH CHECK (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'));
--> statement-breakpoint
ALTER TABLE board_access_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE board_access_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_board_access_entries" ON "board_access_entries" USING (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default')) WITH CHECK (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'));
--> statement-breakpoint
ALTER TABLE branch_permission_configs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE branch_permission_configs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_permission_configs" ON "branch_permission_configs" USING (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default')) WITH CHECK (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'));
--> statement-breakpoint
ALTER TABLE branch_permission_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE branch_permission_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_permission_entries" ON "branch_permission_entries" USING (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default')) WITH CHECK (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'));
--> statement-breakpoint
ALTER TABLE branch_session_sharing_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE branch_session_sharing_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_session_sharing_rules" ON "branch_session_sharing_rules" USING (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default')) WITH CHECK (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'));
--> statement-breakpoint
ALTER TABLE branch_session_sharing_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE branch_session_sharing_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_session_sharing_grants" ON "branch_session_sharing_grants" USING (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default')) WITH CHECK (tenant_id=COALESCE(NULLIF(current_setting('agor.tenant_id',true),''),'default'));
--> statement-breakpoint

-- Restore FORCE row-level security dropped at the top of this migration.
ALTER TABLE "boards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_owners" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_owners" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_group_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_group_grants" FORCE ROW LEVEL SECURITY;
