SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "runtime_installation_identity" (
  "identity_key" text PRIMARY KEY DEFAULT 'primary' NOT NULL,
  "protocol_version" integer DEFAULT 1 NOT NULL,
  "deployment_id" text NOT NULL,
  "database_incarnation_id" text NOT NULL,
  "database_name" text NOT NULL,
  "logical_database_id" text NOT NULL,
  "team_id" text NOT NULL,
  "placement_id" text NOT NULL,
  "placement_revision" bigint NOT NULL,
  "placement_origin" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_installation_identity_key_check" CHECK ("identity_key" = 'primary'),
  CONSTRAINT "runtime_installation_identity_protocol_version_check" CHECK ("protocol_version" = 1),
  CONSTRAINT "runtime_installation_identity_placement_revision_check" CHECK ("placement_revision" >= 0 AND "placement_revision" <= 9007199254740991)
);
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
