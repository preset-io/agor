CREATE TABLE "artifacts" (
	"artifact_id" varchar(36) PRIMARY KEY NOT NULL,
	"worktree_id" varchar(36) NOT NULL,
	"board_id" varchar(36) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"path" text NOT NULL,
	"template" text DEFAULT 'react' NOT NULL,
	"build_status" text DEFAULT 'unknown' NOT NULL,
	"build_errors" text,
	"content_hash" text,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_worktree_idx" ON "artifacts" USING btree ("worktree_id");--> statement-breakpoint
CREATE INDEX "artifacts_board_idx" ON "artifacts" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "artifacts_archived_idx" ON "artifacts" USING btree ("archived");