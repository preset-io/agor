ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_repo_id_repos_repo_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_session_id_sessions_session_id_fk";
--> statement-breakpoint
DROP INDEX "mcp_servers_team_idx";--> statement-breakpoint
DROP INDEX "mcp_servers_repo_idx";--> statement-breakpoint
DROP INDEX "mcp_servers_session_idx";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "repo_id";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "session_id";