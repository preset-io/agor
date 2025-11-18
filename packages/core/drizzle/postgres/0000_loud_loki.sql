CREATE TABLE "board_comments" (
	"comment_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"board_id" varchar(36) NOT NULL,
	"created_by" varchar(36) DEFAULT 'anonymous' NOT NULL,
	"session_id" varchar(36),
	"task_id" varchar(36),
	"message_id" varchar(36),
	"worktree_id" varchar(36),
	"content" text NOT NULL,
	"content_preview" text NOT NULL,
	"parent_comment_id" varchar(36),
	"resolved" boolean DEFAULT false NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"reactions" jsonb DEFAULT '[]' NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_objects" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"board_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"worktree_id" varchar(36) NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"board_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"created_by" varchar(36) DEFAULT 'anonymous' NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"data" jsonb NOT NULL,
	CONSTRAINT "boards_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"mcp_server_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"scope" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_user_id" varchar(36),
	"team_id" varchar(36),
	"repo_id" varchar(36),
	"session_id" varchar(36),
	"source" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"message_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"task_id" varchar(36),
	"type" text NOT NULL,
	"role" text NOT NULL,
	"index" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"content_preview" text,
	"parent_tool_use_id" text,
	"status" text,
	"queue_position" integer,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"repo_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"slug" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "repos_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session_mcp_servers" (
	"session_id" varchar(36) NOT NULL,
	"mcp_server_id" varchar(36) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"created_by" varchar(36) DEFAULT 'anonymous' NOT NULL,
	"status" text NOT NULL,
	"agentic_tool" text NOT NULL,
	"board_id" varchar(36),
	"parent_session_id" varchar(36),
	"forked_from_session_id" varchar(36),
	"worktree_id" varchar(36) NOT NULL,
	"scheduled_run_at" integer,
	"scheduled_from_worktree" boolean DEFAULT false NOT NULL,
	"ready_for_prompt" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_reason" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"task_id" varchar(36) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status" text NOT NULL,
	"created_by" varchar(36) DEFAULT 'anonymous' NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"name" text,
	"emoji" text,
	"role" text DEFAULT 'member' NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worktrees" (
	"worktree_id" varchar(36) PRIMARY KEY NOT NULL,
	"repo_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"created_by" varchar(36) DEFAULT 'anonymous' NOT NULL,
	"name" text NOT NULL,
	"ref" text NOT NULL,
	"worktree_unique_id" integer NOT NULL,
	"start_command" text,
	"stop_command" text,
	"health_check_url" text,
	"app_url" text,
	"logs_command" text,
	"board_id" varchar(36),
	"schedule_enabled" boolean DEFAULT false NOT NULL,
	"schedule_cron" text,
	"schedule_last_triggered_at" integer,
	"schedule_next_run_at" integer,
	"needs_attention" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" varchar(36),
	"filesystem_status" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_comments" ADD CONSTRAINT "board_comments_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_comments" ADD CONSTRAINT "board_comments_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_comments" ADD CONSTRAINT "board_comments_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_comments" ADD CONSTRAINT "board_comments_message_id_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("message_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_comments" ADD CONSTRAINT "board_comments_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_objects" ADD CONSTRAINT "board_objects_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_objects" ADD CONSTRAINT "board_objects_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_repo_id_repos_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ADD CONSTRAINT "session_mcp_servers_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ADD CONSTRAINT "session_mcp_servers_mcp_server_id_mcp_servers_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("mcp_server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_repo_id_repos_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_comments_board_idx" ON "board_comments" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "board_comments_session_idx" ON "board_comments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "board_comments_task_idx" ON "board_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "board_comments_message_idx" ON "board_comments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "board_comments_worktree_idx" ON "board_comments" USING btree ("worktree_id");--> statement-breakpoint
CREATE INDEX "board_comments_created_by_idx" ON "board_comments" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "board_comments_parent_idx" ON "board_comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "board_comments_created_idx" ON "board_comments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "board_comments_resolved_idx" ON "board_comments" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX "board_objects_board_idx" ON "board_objects" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "board_objects_worktree_idx" ON "board_objects" USING btree ("worktree_id");--> statement-breakpoint
CREATE INDEX "boards_name_idx" ON "boards" USING btree ("name");--> statement-breakpoint
CREATE INDEX "boards_slug_idx" ON "boards" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "mcp_servers_name_idx" ON "mcp_servers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "mcp_servers_scope_idx" ON "mcp_servers" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_idx" ON "mcp_servers" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_team_idx" ON "mcp_servers" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_repo_idx" ON "mcp_servers" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_session_idx" ON "mcp_servers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_enabled_idx" ON "mcp_servers" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "messages_session_id_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "messages_task_id_idx" ON "messages" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "messages_session_index_idx" ON "messages" USING btree ("session_id","index");--> statement-breakpoint
CREATE INDEX "messages_queue_idx" ON "messages" USING btree ("session_id","status","queue_position");--> statement-breakpoint
CREATE INDEX "repos_slug_idx" ON "repos" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_mcp_servers_pk" ON "session_mcp_servers" USING btree ("session_id","mcp_server_id");--> statement-breakpoint
CREATE INDEX "session_mcp_servers_session_idx" ON "session_mcp_servers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_mcp_servers_server_idx" ON "session_mcp_servers" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "session_mcp_servers_enabled_idx" ON "session_mcp_servers" USING btree ("session_id","enabled");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_agentic_tool_idx" ON "sessions" USING btree ("agentic_tool");--> statement-breakpoint
CREATE INDEX "sessions_board_idx" ON "sessions" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "sessions_worktree_idx" ON "sessions" USING btree ("worktree_id");--> statement-breakpoint
CREATE INDEX "sessions_created_idx" ON "sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_parent_idx" ON "sessions" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX "sessions_forked_idx" ON "sessions" USING btree ("forked_from_session_id");--> statement-breakpoint
CREATE INDEX "sessions_scheduled_flag_idx" ON "sessions" USING btree ("scheduled_from_worktree");--> statement-breakpoint
CREATE INDEX "tasks_session_idx" ON "tasks" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_created_idx" ON "tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "worktrees_repo_idx" ON "worktrees" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "worktrees_name_idx" ON "worktrees" USING btree ("name");--> statement-breakpoint
CREATE INDEX "worktrees_ref_idx" ON "worktrees" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "worktrees_board_idx" ON "worktrees" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "worktrees_created_idx" ON "worktrees" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "worktrees_updated_idx" ON "worktrees" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "worktrees_repo_name_unique" ON "worktrees" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX "worktrees_schedule_enabled_idx" ON "worktrees" USING btree ("schedule_enabled");--> statement-breakpoint
CREATE INDEX "worktrees_board_schedule_idx" ON "worktrees" USING btree ("board_id","schedule_enabled");