-- Main and the withdrawn callback draft both used watermark 1789344000005.
-- Reconcile either history after the draft retirement watermark (0006),
-- preserving stored rows, tenant isolation, and management transfer support.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "completion_subscriptions" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"subscription_id" varchar(36) PRIMARY KEY NOT NULL,
	"propagation_mode" text DEFAULT 'root' NOT NULL,
	"join_policy" text DEFAULT 'designated_child' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" varchar(36) NOT NULL,
	"origin_session_id" varchar(36) NOT NULL,
	"origin_task_id" varchar(36) NOT NULL,
	"callback_session_id" varchar(36),
	"root_session_id" varchar(36),
	"root_task_id" varchar(36),
	"active_session_id" varchar(36),
	"active_task_id" varchar(36),
	"path" jsonb NOT NULL,
	"max_depth" integer DEFAULT 8 NOT NULL,
	"terminal_status" text,
	"terminal_snapshot" jsonb,
	"delivery_task_id" varchar(36),
	"delivery_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_delivery_at" timestamp with time zone,
	"last_delivery_error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"delegated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "completion_sub_callback_session_fk" FOREIGN KEY ("callback_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "completion_sub_root_session_fk" FOREIGN KEY ("root_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "completion_sub_root_task_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE set null DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "completion_sub_active_session_fk" FOREIGN KEY ("active_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "completion_sub_active_task_fk" FOREIGN KEY ("active_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE set null DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "completion_sub_delivery_task_fk" FOREIGN KEY ("delivery_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE set null DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "completion_subscriptions_tenant_id_idx" ON "completion_subscriptions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "completion_subscriptions_root_task_unique" ON "completion_subscriptions" USING btree ("tenant_id","root_task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "completion_subscriptions_active_task_idx" ON "completion_subscriptions" USING btree ("tenant_id","active_task_id","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "completion_subscriptions_callback_idx" ON "completion_subscriptions" USING btree ("tenant_id","callback_session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "completion_subscriptions_delivery_due_idx" ON "completion_subscriptions" USING btree ("tenant_id","state","next_delivery_at","subscription_id");
--> statement-breakpoint
ALTER TABLE "completion_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "completion_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_completion_subscriptions" ON "completion_subscriptions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_completion_subscriptions" ON "completion_subscriptions"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
-- Root propagation was withdrawn. Preserve stored rows and tenant isolation,
-- but revoke its unused cross-tenant discovery capability (including on Tasks).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP POLICY IF EXISTS "completion_callback_task_discovery" ON "tasks";--> statement-breakpoint
DROP POLICY IF EXISTS "completion_callback_discovery" ON "completion_subscriptions";

--> statement-breakpoint
-- Bound table-lock acquisition; a busy migration rolls back rather than
-- stalling normal traffic indefinitely. No owner rows or authorship are changed.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS boards_primary_owner_immutable ON boards;
--> statement-breakpoint
DROP TRIGGER IF EXISTS branches_primary_owner_immutable ON branches;
--> statement-breakpoint
DROP FUNCTION IF EXISTS agor_reject_primary_owner_change();
-- Tenant-qualified owner FKs, NOT NULL constraints and FORCE RLS remain intact.
-- Authorization/eligibility is enforced by the shared application command.

--> statement-breakpoint
-- Draft retirement/reconciliation watermarks (0006/0007) could skip main's
-- KB receipts migration (0006). Reconcile it without replacing existing rows.
CREATE TABLE IF NOT EXISTS "kb_import_receipts" (
 "tenant_id" text DEFAULT 'default' NOT NULL,
 "receipt_id" text PRIMARY KEY NOT NULL,
 "owner_user_id" varchar(36) NOT NULL,
 "bundle" text NOT NULL,
 "slug" text NOT NULL,
 "entry_key" text NOT NULL,
 "target_id" text NOT NULL,
 "digest" text NOT NULL,
 "request_bytes" integer DEFAULT 0 NOT NULL,
 "reconciled_count" integer DEFAULT -1 NOT NULL,
 "created_at" timestamp with time zone NOT NULL,
 CONSTRAINT "kb_import_receipts_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_import_receipts_tenant_idx" ON "kb_import_receipts" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_import_receipts_identity_unique" ON "kb_import_receipts" ("tenant_id", "owner_user_id", "bundle", "slug", "entry_key");
--> statement-breakpoint
ALTER TABLE "kb_import_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_import_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_import_receipts" ON "kb_import_receipts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_import_receipts" ON "kb_import_receipts"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
