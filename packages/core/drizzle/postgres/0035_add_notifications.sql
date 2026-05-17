CREATE TABLE "notifications" (
	"notification_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"recipient_user_id" varchar(36) NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"preview" text,
	"source_session_id" varchar(36),
	"source_worktree_id" varchar(36),
	"source_board_id" varchar(36),
	"source_comment_id" varchar(36),
	"source_task_id" varchar(36),
	"source_user_id" varchar(36),
	"read_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_session_id_sessions_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("source_worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_board_id_boards_board_id_fk" FOREIGN KEY ("source_board_id") REFERENCES "public"."boards"("board_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_comment_id_board_comments_comment_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."board_comments"("comment_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_user_id_users_user_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_read_idx" ON "notifications" USING btree ("recipient_user_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_source_type_idx" ON "notifications" USING btree ("recipient_user_id","source_session_id","type");--> statement-breakpoint
CREATE INDEX "notifications_source_session_idx" ON "notifications" USING btree ("source_session_id");--> statement-breakpoint
CREATE INDEX "notifications_source_worktree_idx" ON "notifications" USING btree ("source_worktree_id");
