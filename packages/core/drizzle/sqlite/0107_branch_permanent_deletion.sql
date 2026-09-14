-- Branch-local lifecycle only: retain the branch until required deletion succeeds.
ALTER TABLE "branches" ADD COLUMN "deletion_status" text;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "deletion_error" text;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "deletion_updated_at" integer;
