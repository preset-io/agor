ALTER TABLE "boards" RENAME COLUMN "primary_assistant_id" TO "primary_teammate_id";--> statement-breakpoint
ALTER TABLE "boards" RENAME CONSTRAINT "boards_primary_assistant_id_branches_branch_id_fk" TO "boards_primary_teammate_id_branches_branch_id_fk";--> statement-breakpoint
