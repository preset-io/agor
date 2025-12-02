CREATE TABLE "worktree_owners" (
	"worktree_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "worktree_owners_worktree_id_user_id_pk" PRIMARY KEY("worktree_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "unix_username" text;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "others_can" text DEFAULT 'view';--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "unix_group" text;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "others_fs_access" text DEFAULT 'read';--> statement-breakpoint
ALTER TABLE "worktree_owners" ADD CONSTRAINT "worktree_owners_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktree_owners" ADD CONSTRAINT "worktree_owners_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;