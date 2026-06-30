CREATE TABLE "gateway_outbound_messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"gateway_channel_id" varchar(36) NOT NULL,
	"channel_type" text NOT NULL,
	"platform_channel_id" text NOT NULL,
	"platform_message_id" text NOT NULL,
	"platform_thread_id" text NOT NULL,
	"platform_permalink" text,
	"target_branch_id" varchar(36) NOT NULL,
	"emitted_by_user_id" varchar(36) NOT NULL,
	"emitted_by_session_id" varchar(36),
	"emitted_by_task_id" varchar(36),
	"emitted_by_schedule_id" varchar(36),
	"message_text" text NOT NULL,
	"message_preview" text NOT NULL,
	"metadata" jsonb,
	"consumed_by_session_id" varchar(36),
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD CONSTRAINT "gateway_outbound_messages_gateway_channel_id_gateway_channels_id_fk" FOREIGN KEY ("gateway_channel_id") REFERENCES "public"."gateway_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD CONSTRAINT "gateway_outbound_messages_target_branch_id_branches_branch_id_fk" FOREIGN KEY ("target_branch_id") REFERENCES "public"."branches"("branch_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD CONSTRAINT "gateway_outbound_messages_emitted_by_user_id_users_user_id_fk" FOREIGN KEY ("emitted_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD CONSTRAINT "gateway_outbound_messages_emitted_by_session_id_sessions_session_id_fk" FOREIGN KEY ("emitted_by_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD CONSTRAINT "gateway_outbound_messages_emitted_by_task_id_tasks_task_id_fk" FOREIGN KEY ("emitted_by_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD CONSTRAINT "gateway_outbound_messages_emitted_by_schedule_id_schedules_schedule_id_fk" FOREIGN KEY ("emitted_by_schedule_id") REFERENCES "public"."schedules"("schedule_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD CONSTRAINT "gateway_outbound_messages_consumed_by_session_id_sessions_session_id_fk" FOREIGN KEY ("consumed_by_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gateway_outbound_channel_thread" ON "gateway_outbound_messages" USING btree ("gateway_channel_id","platform_thread_id");
--> statement-breakpoint
CREATE INDEX "idx_gateway_outbound_emitted_session" ON "gateway_outbound_messages" USING btree ("emitted_by_session_id");
--> statement-breakpoint
CREATE INDEX "idx_gateway_outbound_emitted_schedule" ON "gateway_outbound_messages" USING btree ("emitted_by_schedule_id");
--> statement-breakpoint
CREATE INDEX "idx_gateway_outbound_branch_created" ON "gateway_outbound_messages" USING btree ("target_branch_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_gateway_outbound_consumed" ON "gateway_outbound_messages" USING btree ("consumed_at");
