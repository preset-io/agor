-- Fix foreign key constraint on thread_session_map.session_id to add ON DELETE CASCADE
-- This allows sessions to be deleted without violating the foreign key constraint
--
-- Note: SQLite doesn't support ALTER TABLE DROP/ADD CONSTRAINT directly.
-- We need to recreate the table with the correct foreign key.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE "thread_session_map_new" (
	"id" text(36) PRIMARY KEY NOT NULL,
	"created_at" integer NOT NULL,
	"last_message_at" integer NOT NULL,
	"channel_id" text(36) NOT NULL,
	"thread_id" text NOT NULL,
	"session_id" text(36) NOT NULL,
	"worktree_id" text(36) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" text,
	FOREIGN KEY ("channel_id") REFERENCES "gateway_channels"("id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("worktree_id") REFERENCES "worktrees"("worktree_id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
INSERT INTO "thread_session_map_new" SELECT * FROM "thread_session_map";--> statement-breakpoint
DROP TABLE "thread_session_map";--> statement-breakpoint
ALTER TABLE "thread_session_map_new" RENAME TO "thread_session_map";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_thread_map_channel_thread" ON "thread_session_map" ("channel_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_thread_map_session_id" ON "thread_session_map" ("session_id");--> statement-breakpoint
CREATE INDEX "idx_thread_map_channel_status" ON "thread_session_map" ("channel_id","status");--> statement-breakpoint
PRAGMA foreign_keys=ON;
