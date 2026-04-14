-- Add session_md5 column to tasks table
ALTER TABLE "tasks" ADD COLUMN "session_md5" text;--> statement-breakpoint

-- Create serialized_sessions table for stateless_fs_mode
CREATE TABLE "serialized_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"worktree_id" varchar(36) NOT NULL,
	"task_id" varchar(36),
	"turn_index" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL,
	"md5" text NOT NULL,
	"status" text NOT NULL,
	"payload" bytea
);--> statement-breakpoint

-- Add foreign keys
ALTER TABLE "serialized_sessions" ADD CONSTRAINT "serialized_sessions_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serialized_sessions" ADD CONSTRAINT "serialized_sessions_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serialized_sessions" ADD CONSTRAINT "serialized_sessions_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Create indexes
CREATE INDEX "serialized_sessions_session_turn_idx" ON "serialized_sessions" USING btree ("session_id","turn_index");--> statement-breakpoint
CREATE INDEX "serialized_sessions_worktree_idx" ON "serialized_sessions" USING btree ("worktree_id");
