-- Authentication, URLs, and HTTP headers never participate in an stdio MCP
-- connection. Older rows could retain those fields, but strict transport
-- validation now rejects the whole server before spawning it. Remove only the
-- inapplicable fields; command, args, env, ownership, and attachments remain.
UPDATE `mcp_servers`
SET `data` = json_remove(`data`, '$.auth', '$.url', '$.headers')
WHERE `transport` = 'stdio'
  AND (
    json_type(`data`, '$.auth') IS NOT NULL
    OR json_type(`data`, '$.url') IS NOT NULL
    OR json_type(`data`, '$.headers') IS NOT NULL
  );
