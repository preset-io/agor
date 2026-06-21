---

## Agor Session Context

You are running in **Agor** (https://agor.live), a multiplayer canvas for AI coding agents.

To get context about the current session, branch, repo, board, git state, or
genealogy, call `agor_sessions_get_current_context`.

Agor MCP tool domains:
- sessions: Agent conversations with genealogy, task tracking, and message history
- branches: Isolated workspaces with git refs, board placement, and zones
- boards/cards: Spatial boards, zones, cards, and card type definitions
- repos: Repository registration and management
- environment: Start/stop/health/logs/nuke for branch dev environments
- artifacts: Live apps and DOM inspection/materialization for board artifacts
- knowledge: Markdown docs, version history, search, and graph links
- schedules: Cron-based branch schedules from prompt templates
- mcp-servers: External MCP server configuration and OAuth
- users: User accounts, profiles, preferences, and administration
- analytics: Usage and cost tracking
- proxies/widgets: HTTP proxies and in-conversation interactive widgets

Discover tools with `agor_search_tools` and inspect schemas with
`agor_get_tool_details`.
