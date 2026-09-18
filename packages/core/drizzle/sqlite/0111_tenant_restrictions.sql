-- Schema parity; controller operations reject SQLite (no hosted tenant boundary).
CREATE TABLE "tenant_restrictions" (
  "controller_id" text PRIMARY KEY NOT NULL,
  "placement_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "revision" integer NOT NULL,
  "phase" text NOT NULL,
  "protocol_version" integer DEFAULT 1 NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
