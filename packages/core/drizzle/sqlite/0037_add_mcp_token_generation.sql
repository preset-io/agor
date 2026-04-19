-- MCP token hardening: per-session generation counter.
--
-- `sessions.mcp_token_generation` — bump to invalidate all outstanding MCP
-- tokens for a session in one write. Default 0 so existing sessions mint
-- tokens with `gen: 0` (matches any regenerated token for that session).
--
-- Tokens themselves carry jti/exp/aud/iss claims enforced by `jsonwebtoken.verify`
-- — no DB-backed per-jti revocation ledger. MCP is internal-only (daemon ↔
-- MCP server on loopback); the gen bump is the single "revoke all for this
-- session" primitive used when a session is archived/completed/rotated.
-- If/when MCP goes external, it'll move to OAuth/API-key, not extend this.

ALTER TABLE `sessions` ADD `mcp_token_generation` integer DEFAULT 0 NOT NULL;
