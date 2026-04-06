ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_worktree_id_worktrees_worktree_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "worktree_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "files" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "dependencies" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "entry" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "use_local_bundler" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_worktree_id_worktrees_worktree_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."worktrees"("worktree_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_public_idx" ON "artifacts" USING btree ("public");