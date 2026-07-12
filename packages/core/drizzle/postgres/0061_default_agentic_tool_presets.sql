ALTER TABLE "agentic_tool_presets" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agentic_tool_presets_tenant_tool_default_unique"
ON "agentic_tool_presets" ("tenant_id", "tool")
WHERE "is_default" = true;
