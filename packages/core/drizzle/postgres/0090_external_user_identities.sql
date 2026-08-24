SET LOCAL lock_timeout = '3s';--> statement-breakpoint
-- Execution-home keys route delegated execution and credentials, so two users
-- in one tenant must never share one. NULL remains available for users without
-- a delegated execution home.
CREATE UNIQUE INDEX "users_tenant_unix_username_unique"
	ON "users" ("tenant_id", "unix_username");--> statement-breakpoint
CREATE TABLE "user_external_identities" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"identity_key" varchar(64) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"provider" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"name" text,
	"last_login_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_external_identities_tenant_id_identity_key_pk"
		PRIMARY KEY("tenant_id", "identity_key"),
	CONSTRAINT "user_external_identities_tenant_user_fk"
		FOREIGN KEY ("tenant_id", "user_id")
		REFERENCES "public"."users"("tenant_id", "user_id")
		ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE
);--> statement-breakpoint
CREATE UNIQUE INDEX "user_external_identities_provider_subject_unique"
	ON "user_external_identities" ("tenant_id", "provider", "issuer", "subject");--> statement-breakpoint
CREATE INDEX "user_external_identities_tenant_user_idx"
	ON "user_external_identities" ("tenant_id", "user_id");--> statement-breakpoint
-- Backfill the compatibility JSON projection. Conflicting legacy bindings fail
-- the migration instead of letting a login select an arbitrary user.
INSERT INTO "user_external_identities" (
	"tenant_id", "identity_key", "user_id", "provider", "issuer", "subject",
	"email", "name", "last_login_at", "created_at", "updated_at"
)
SELECT
	u."tenant_id",
	identity.value->>'key',
	u."user_id",
	identity.value->>'provider',
	identity.value->>'issuer',
	identity.value->>'subject',
	identity.value->>'email',
	identity.value->>'name',
	COALESCE((identity.value->>'last_login_at')::timestamp with time zone, u."updated_at", u."created_at"),
	u."created_at",
	COALESCE(u."updated_at", u."created_at")
FROM "users" u
CROSS JOIN LATERAL jsonb_array_elements(
	CASE
		WHEN jsonb_typeof(u."data"->'external_identities') = 'array'
		THEN u."data"->'external_identities'
		ELSE '[]'::jsonb
	END
) AS identity(value)
WHERE identity.value->>'key' IS NOT NULL
	AND identity.value->>'provider' IS NOT NULL
	AND identity.value->>'issuer' IS NOT NULL
	AND identity.value->>'subject' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "user_external_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_external_identities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_user_external_identities" ON "user_external_identities"
	USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
	WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
