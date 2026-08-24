-- Protocol cutover: every daemon must issue and validate the matching token
-- claim before password writes resume. Existing users begin at zero.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credential_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
