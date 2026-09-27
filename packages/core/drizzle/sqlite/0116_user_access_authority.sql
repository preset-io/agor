ALTER TABLE "users" ADD COLUMN "access_disabled" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "external_user_authority" (
 "identity_key" text NOT NULL,
 "provider" text NOT NULL,
 "issuer" text NOT NULL,
 "subject" text NOT NULL,
 "revision" text NOT NULL,
 "login_epoch" text NOT NULL,
 "active" integer NOT NULL,
 "role" text NOT NULL,
 PRIMARY KEY ("identity_key")
);
