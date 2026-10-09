# MCP Catalog

Maintainer contract for the curated catalog and catalog Connect. User-facing behavior lives in
[`mcp-servers.mdx`](../../apps/agor-docs/content/guide/mcp-servers.mdx); contribution rules in
[`development.mdx`](../../apps/agor-docs/content/guide/development.mdx#contributing-to-the-mcp-catalog).

## Source and read path

The catalog is exactly `packages/core/src/mcp-catalog/curated.yaml`, loaded into
the daemon on first read. No table, no ingestion job: adding a server is a PR,
removing one takes it off the shelf on the next deploy.

- `entries:` are names the public [MCP registry](https://registry.modelcontextprotocol.io)
  publishes; `unpublished:` are vendor endpoints whose reverse-DNS name Agor
  inferred. The split is a curation record only; parsing flattens both.
- `name` is the identity, recorded on installs as `catalog_entry_name`.
  Renaming an entry orphans every install.
- `find` takes no query and returns every entry; the UI does all
  search/filter/sort/paging. Narrowing lives only in
  `packages/core/src/mcp-catalog/query.ts` (browser imports it as
  `@agor/core/mcp-catalog/query`; it is separate from `catalog.ts`, which reads
  from disk and can't be bundled). `get(name)` resolves a `catalog_key` to URL
  and transport on Connect.

## Connect probing

An entry's `auth_type` (`none` / `oauth` / `credentials`, or omitted) only
shapes what the UI says before Connect. `mcp-catalog-connect.ts` probes the
endpoint on every connect regardless:

- valid JSON-RPC `initialize` → install open;
- OAuth challenge → `per_user` OAuth row;
- non-OAuth challenge → install only if the entry has a reviewed bearer
  recipe and the caller's key passes a second `initialize`.

Probe/entry mismatches log at `warn`. `.github/workflows/mcp-catalog-health.yml`
repeats the comparison on curation PRs and on a schedule, and fails on
actionable auth/OAuth drift (transient reachability is annotated separately).

Both probes use `createPinnedFetch` (`packages/core/src/utils/pinned-fetch.ts`):
resolve, refuse unless every address is public, connect to the checked address,
**no redirects**, one request to the entry's URL only — so a key can't be handed
to whatever a redirect names.

## Bearer keys

- Keys never go in `curated.yaml` (public, identical for every tenant). The
  key arrives as `bearer_token`, the only caller-supplied field on Connect;
  URL, transport, and credential kind derive server-side from the entry.
- Stored as `auth.token` on the `mcp_servers` row, covered by
  `redactMCPAuthSecrets`.
- Before the authenticated probe (`probeRemoteBearerToken`), Connect durably
  claims the caller's generation for that install so an older concurrent
  request can't overwrite a newer key. The row is written only after the key
  is accepted.
- A reviewed entry may change how the key is sent: `credentials.header`
  (default `Authorization`) and a literal `credentials.prefix` (default
  `Bearer ` only when `header` is omitted; e.g. PagerDuty's `Token token=`).
  These persist as non-secret `auth.token_header` / `auth.token_prefix` and are
  rendered by `renderMCPTokenHeader` for the probe and every runtime.
- `credentials.fields` declares extra user values sent as headers alongside the
  key (e.g. dbt's `x-dbt-prod-environment-id`). They arrive as
  `credential_fields`, only with `bearer_token`, all required, and are stored
  in the row's custom `headers` (redacted on every read). The request fills
  values; only the entry names headers. A current install of such an entry
  carries headers; every other catalog install carries none.
- Rows holding a secret in their own columns are reusable only by their owner:
  two users get two rows; reconnecting with a new key rotates the existing row.

## OAuth

- **Credential-peer reuse.** Connect may reuse or refresh a live `per_user`
  grant only for a peer with the same catalog endpoint, requested scope,
  compatibility/DCR/client policy, and recorded protected resource. Shared
  grants, other users' grants, routing overrides, custom headers, stale
  bindings, and mismatched resources are ineligible. Reusing a user-configured
  peer doesn't convert it into a catalog install.
- **`marketplace` profile.** OAuth entries without `oauth.compatibility_mode`
  get an internal, non-persistable `marketplace` profile, derived only while the
  saved row is still a canonical install of the current entry (provenance,
  endpoint, transport, auth prescription, empty custom headers). It admits only
  the reviewed interoperability fallbacks in `oauth-mcp-transport.ts`, keeping
  same-origin bounds, resource/issuer binding, the exact MCP URL as RFC 8707
  resource, PKCE S256, and callback issuer validation. A saved `strict`/`legacy`
  mode wins; edited/imported installs, removed entries, or any drift fall back
  to `strict`. Monday, Cloudflare, ClickUp, and Preset are pinned `strict`
  (Preset defensively, pending production validation).
- **Excluded providers.** Prisma, MongoDB, and Kagi are off the shelf because
  no safely bound client-registration/issuer path exists (reasons at the bottom
  of `curated.yaml`). Box, HubSpot, Slack, and Google Workspace are offered only
  as customer-owned app recipes; PagerDuty only via its user API token. Don't
  re-add a DCR entry just because its endpoint returns an OAuth challenge.
- **Declared OAuth.** An `auth_type: oauth` entry with a reviewed client
  (`configured_client` or `client_id`, see `catalogEntryDeclaresOAuth`) is
  installed for OAuth even when the endpoint answers `initialize` with no
  challenge (Google Workspace), and oauth-start then discovers from the
  server's well-known metadata. Only current installs of such entries skip the
  401 requirement; manual and drifted rows keep the challenge-driven contract.
- **Recipe issuer.** State the authorization server metadata `issuer` in
  `configured_client.issuer`. The health audit and hosted-relay flows require
  the recipe issuer to equal that metadata issuer exactly; the relay's callback
  hash and `prepare` binding both use that one string. Only direct (non-relay)
  flows tolerate a single trailing-slash difference
  (`oauthIssuerIdentifiersMatch`). A mismatch fails as an `issuer_mismatch`
  configuration error before registration or relay work.
- **Token endpoint client auth** is HTTP Basic unless a configured-app recipe
  declares `oauth.token_endpoint_auth_method: client_secret_post` (Slack,
  HubSpot). The daemon resolves it from the install's catalog provenance
  (`catalogTokenEndpointAuthMethod`) for both the code exchange and every
  refresh; nothing is stored per grant, and manual servers always use Basic.
  The health audit flags a recipe whose effective method (declared, else Basic)
  the token endpoint doesn't advertise. The field describes the provider and
  should almost never change: changing or removing it after grants exist makes
  their next refresh use the new method, and a provider that refuses it drops
  the grant, so users reconnect. **Rolling upgrade:** replicas that predate the field refresh
  with Basic, so a Slack/HubSpot grant issued mid-rollout can fail an old
  replica's refresh with `invalid_client` and need reconnecting. Finish the
  rollout before connecting those providers.
- **GitHub** uses its documented PAT bearer route as a reviewed exception to its
  OAuth challenge; the health audit flags if its OAuth metadata becomes usable.
- **Sign-in completion.** Connect pre-opens the provider window during user
  activation; the drawer stays **Sign-in pending** until a durable attempt and
  the caller-scoped credential projection confirm success. Popup navigation is
  never success.

## Post-connect and consent

Connect adds or reuses a server and never creates a session. **Start new
session** asks for teammate and agent tool, creates a caller-owned idle session
via the normal service, attaches the server, and seeds the starter prompt as
editable unsent text.

**What this can access** is expanded by default; its checkbox sits inside it
before the destination fields and Connect, and Connect sends the exact shown
text as `acknowledged_disclosure`. Collapsing never counts as consent.

The one exception: `agor_widgets_request_oauth` installs from a catalog entry on
an agent's request, satisfying the check with the entry's own text. This is safe
only because that install is **inert** — `scope: 'session'`, private to the
caller, unattached, unauthorized — and the disclosure is rendered on the widget
above Connect. A later request naming the installed server re-reads the entry's
disclosure and refuses if the entry left the catalog. If such installs ever stop
being inert, redesign this exception first.

## Retired config

The `mcp_catalog:` config section is ignored but still accepted, because
unknown top-level keys throw at load. See `RETIRED_CONFIG_KEYS` in
`packages/core/src/config/config-manager.ts`.
