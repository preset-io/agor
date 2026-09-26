-- Offline protocol cutover: old writers do not understand managed_oauth.
CREATE TABLE "user_provider_oauth_grants" (
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "grant_generation" integer NOT NULL,
  "binding_version" integer NOT NULL,
  "binding_fingerprint" text NOT NULL,
  "established_attempt_id" text NOT NULL,
  "sealed_access_token" text,
  "sealed_refresh_token" text,
  "expires_at" integer,
  "scopes" text DEFAULT '' NOT NULL,
  "subscription_type" text,
  "refresh_generation" integer DEFAULT 0 NOT NULL,
  "refresh_success_generation" integer DEFAULT 0 NOT NULL,
  "refresh_claim_id" text,
  "refresh_claimed_at" integer,
  "state" text DEFAULT 'idle' NOT NULL,
  "failure_code" text,
  "retry_not_before" integer,
  "updated_at" integer NOT NULL,
  PRIMARY KEY ("user_id", "provider"),
  FOREIGN KEY ("user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" ADD COLUMN "submission_count" integer DEFAULT 0 NOT NULL;
