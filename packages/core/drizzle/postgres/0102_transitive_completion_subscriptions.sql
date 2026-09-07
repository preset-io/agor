CREATE TABLE "completion_subscriptions" (
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
CREATE INDEX "completion_subscriptions_tenant_id_idx" ON "completion_subscriptions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "completion_subscriptions_root_task_unique" ON "completion_subscriptions" USING btree ("tenant_id","root_task_id");
--> statement-breakpoint
CREATE INDEX "completion_subscriptions_active_task_idx" ON "completion_subscriptions" USING btree ("tenant_id","active_task_id","state");
--> statement-breakpoint
CREATE INDEX "completion_subscriptions_callback_idx" ON "completion_subscriptions" USING btree ("tenant_id","callback_session_id");
--> statement-breakpoint
CREATE INDEX "completion_subscriptions_delivery_due_idx" ON "completion_subscriptions" USING btree ("tenant_id","state","next_delivery_at","subscription_id");
--> statement-breakpoint
ALTER TABLE "completion_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "completion_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_completion_subscriptions" ON "completion_subscriptions"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
CREATE POLICY "completion_callback_discovery" ON "completion_subscriptions"
  FOR SELECT
  USING (current_setting('agor.system_scope', true) = 'completion_callback_discovery');
--> statement-breakpoint
CREATE POLICY "completion_callback_task_discovery" ON "tasks"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'completion_callback_discovery'
    AND EXISTS (
      SELECT 1
      FROM "completion_subscriptions"
      WHERE "completion_subscriptions"."tenant_id" = "tasks"."tenant_id"
        AND "completion_subscriptions"."active_task_id" = "tasks"."task_id"
        AND "completion_subscriptions"."state" IN ('pending', 'delegated', 'running_downstream')
    )
  );
