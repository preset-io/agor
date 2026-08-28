-- Authentication, URLs, and HTTP headers never participate in an stdio MCP
-- connection. Older rows could retain those fields, but strict transport
-- validation now rejects the whole server before spawning it. Remove only the
-- inapplicable fields; command, args, env, tenant/owner, and attachments remain.
UPDATE "mcp_servers"
SET "data" = "data" - 'auth' - 'url' - 'headers'
WHERE "transport" = 'stdio'
  AND "data" ?| ARRAY['auth', 'url', 'headers'];
