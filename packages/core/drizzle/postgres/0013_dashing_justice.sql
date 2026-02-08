CREATE TABLE "gateway_channels" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" varchar(36) DEFAULT 'anonymous' NOT NULL,
	"name" text NOT NULL,
	"channel_type" text NOT NULL,
	"target_worktree_id" varchar(36) NOT NULL,
	"agor_user_id" varchar(36) NOT NULL,
	"channel_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_message_at" timestamp with time zone,
	"config" jsonb NOT NULL,
	CONSTRAINT "gateway_channels_channel_key_unique" UNIQUE("channel_key")
);
--> statement-breakpoint
CREATE TABLE "thread_session_map" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"channel_id" varchar(36) NOT NULL,
	"thread_id" text NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"worktree_id" varchar(36) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "scheduled_run_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "worktrees" ALTER COLUMN "schedule_last_triggered_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "worktrees" ALTER COLUMN "schedule_next_run_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD CONSTRAINT "gateway_channels_target_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("target_worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_session_map" ADD CONSTRAINT "thread_session_map_channel_id_gateway_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."gateway_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_session_map" ADD CONSTRAINT "thread_session_map_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_session_map" ADD CONSTRAINT "thread_session_map_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gateway_channel_key" ON "gateway_channels" USING btree ("channel_key");--> statement-breakpoint
CREATE INDEX "idx_gateway_enabled_type" ON "gateway_channels" USING btree ("enabled","channel_type");--> statement-breakpoint
CREATE INDEX "uniq_thread_map_channel_thread" ON "thread_session_map" USING btree ("channel_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_thread_map_session_id" ON "thread_session_map" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_thread_map_channel_status" ON "thread_session_map" USING btree ("channel_id","status");