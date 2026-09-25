SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "cleanup_policy" jsonb DEFAULT '{"enabled":false,"command":"git clean -fdX","allow_branch_protection":true}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "cleanup_protected" boolean DEFAULT false NOT NULL;
