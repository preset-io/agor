-- RBAC: Worktree ownership and permissions
CREATE TABLE IF NOT EXISTS "worktree_owners" (
	"worktree_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "worktree_owners_worktree_id_user_id_pk" PRIMARY KEY("worktree_id","user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worktree_owners" ADD CONSTRAINT "worktree_owners_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worktree_owners" ADD CONSTRAINT "worktree_owners_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_unix_username_idx" ON "users" ("unix_username");--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN IF NOT EXISTS "others_can" text DEFAULT 'view' CHECK ("others_can" IN ('none', 'view', 'prompt', 'all'));--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN IF NOT EXISTS "unix_group" text;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN IF NOT EXISTS "others_fs_access" text DEFAULT 'read' CHECK ("others_fs_access" IN ('none', 'read', 'write'));
