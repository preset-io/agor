-- Inert parity only: SQLite cannot admit managed authority.
CREATE TABLE mcp_managed_oauth_cell_retirements (
 cell_id text PRIMARY KEY NOT NULL,
 operation_id text NOT NULL,
 generation text NOT NULL,
 created_at integer NOT NULL
);
