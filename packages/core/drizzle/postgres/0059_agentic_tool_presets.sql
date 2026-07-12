CREATE TABLE "agentic_tool_presets" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"preset_id" varchar(36) PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"configuration" jsonb NOT NULL,
	"created_by" varchar(36) NOT NULL,
	"updated_by" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agentic_tool_presets_tenant_id_idx" ON "agentic_tool_presets" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentic_tool_presets_tenant_tool_name_unique" ON "agentic_tool_presets" USING btree ("tenant_id","tool","name");
--> statement-breakpoint
ALTER TABLE "agentic_tool_presets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agentic_tool_presets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_agentic_tool_presets" ON "agentic_tool_presets"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agentic_tool_preset_id" varchar(36) REFERENCES "agentic_tool_presets"("preset_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "agentic_tool_preset_id" varchar(36) REFERENCES "agentic_tool_presets"("preset_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "agentic_tool_preset_id" varchar(36) REFERENCES "agentic_tool_presets"("preset_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "sessions_agentic_tool_preset_idx" ON "sessions" USING btree ("agentic_tool_preset_id");
--> statement-breakpoint
CREATE INDEX "schedules_agentic_tool_preset_idx" ON "schedules" USING btree ("agentic_tool_preset_id");
--> statement-breakpoint
CREATE INDEX "gateway_channels_agentic_tool_preset_idx" ON "gateway_channels" USING btree ("agentic_tool_preset_id");
