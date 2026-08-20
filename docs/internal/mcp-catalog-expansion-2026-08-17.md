# MCP catalog expansion — finalized against current Marketplace OAuth

**Original research:** 2026-08-17
**Final verification:** 2026-08-20
**Branch:** `catalog-expansion-research` (rebased locally as `pr-2481-ready`)
**Outcome:** current `main` has 40 installable entries; this change adds **11**, for
**51 installable entries**. Ten use reviewed Marketplace OAuth discovery and one
(Clerk) is genuinely open. Render is rejected at the pre-DCR client boundary.

This report supersedes both the original initialize-only acceptance decision and the
overstated first finalization audit. Sections 3–5 retain the earlier broad candidate
research as provenance; the final accepted set, counts, ranks, and verification record
are in §§2, 6, 8, and 11.

---

## 1. Final verification method

The original 2026-08-17 pass sent at least three `probeRemoteAuthType` handshakes to
each proposed endpoint and checked vendor documentation. That established endpoint,
transport, and initial auth classification, but **not** whether Agor could safely start
the OAuth flow. #2491 demonstrated that initialize-only evidence is insufficient.

On 2026-08-20 every proposed OAuth entry was rechecked in two deliberately distinct
layers.

### 1.1 Live-provider metadata and core validation

The live-provider pass performed:

1. unauthenticated MCP `initialize` using the catalog probe request;
2. `resolveMCPOAuthDiscovery(..., { compatibilityMode: "marketplace" })`;
3. live protected-resource and authorization-server metadata fetches through Agor's
   hardened outbound fetch path;
4. direct `startMCPOAuthFlow` core validation with `marketplace`, a nonfunctional
   placeholder client ID, and DCR disabled, covering resource/issuer safety, HTTPS
   endpoint validation, and PKCE S256 before constructing a placeholder authorization
   URL.

This live pass **did not call** `/mcp-servers/oauth-start`. The placeholder client ID
bypassed both Dynamic Client Registration and the automatic all-resource-scope branch;
it also did not exercise canonical saved-row policy derivation, deployment callback
resolution, pending-attempt creation, or provider acceptance of an Agor redirect URI.
No live DCR or authorization endpoint was called, and no provider-side client or grant
was created. The live result is evidence about current metadata and core safety
validation only.

### 1.2 Mocked daemon service-boundary fixture

A deterministic SQLite integration test now calls the registered
`/mcp-servers/oauth-start` service with a canonical, current catalog row and no saved
client ID. Its local provider fixture publishes protected-resource scopes matching the
five-scope Customer.io shape, advertises DCR, supports S256, and intentionally omits the
strict-only RFC 9207 response-issuer flag. The test proves that the service:

1. ignores a request-supplied placeholder client ID and reloads the saved row;
2. derives `marketplace` with reason `current_catalog_marketplace` from the canonical
   catalog identity, endpoint, transport, auth, and no-header policy;
3. resolves the exact deployment callback
   `https://agor.example.test/mcp-servers/oauth-callback`;
4. selects **all** advertised protected-resource scopes and places them, in order, in
   the DCR request; and
5. reaches the fixture's DCR endpoint, which records the request and returns HTTP 418
   without allocating a client.

The service returns the redacted `dcr_registration` diagnostic and redirect, with no
authorization URL, token request, or pending-attempt ID. This safely covers Agor's
actual pre-mutation service seam. It is fixture evidence for the shared implementation,
**not** a claim that any live vendor accepted DCR, registered Agor's callback, or created
a durable pending attempt.

Acceptance requires safe live metadata with an advertised DCR endpoint (or a separately
reviewed public client, of which this final set uses none), plus the service-boundary
fixture above. None of the accepted OAuth rows needs catalog OAuth overrides; all use
#2491's derived `marketplace` mode. None is labeled `strict`.

Clerk was rechecked beyond `initialize`: notification, `tools/list`, and a real
`list_clerk_sdk_snippets` tool call with no credentials. Firecrawl's corrected `/v2/mcp`
URL was likewise re-run through a real unauthenticated `firecrawl_scrape` call. Vendor
documentation and every permission disclosure were re-read for all eleven accepted
entries. Registry provenance was re-read from the official MCP Registry API, including
Tavily's official identity.

---

## 2. Accepted — 11 new entries

All ten OAuth endpoints returned an OAuth challenge. Direct core validation constructed
a placeholder-client authorization URL containing `resource`, `code_challenge`, and
`code_challenge_method=S256`; for the reasons in §1.1 this is not service-boundary, DCR,
automatic-scope, redirect-registration, or pending-authority evidence. Live metadata and
DCR endpoint declarations below were fetched/discovered, never called for registration.

| Vendor      | Endpoint                                          | Live discovery and binding                                                                         | Client boundary                                                       | Policy      | Decision |
| ----------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------- | -------- |
| Postman     | `https://mcp.postman.com/mcp`                     | Header PRM; exact resource; issuer `https://mcp.postman.com`; S256                                 | Advertised `/register`                                                | marketplace | Accept   |
| Cloudinary  | `https://asset-management.mcp.cloudinary.com/mcp` | Header PRM; same-origin parent resource; same-origin issuer; S256                                  | Advertised `/register`                                                | marketplace | Accept   |
| Miro        | `https://mcp.miro.com/`                           | Header PRM; exact resource and issuer; S256                                                        | Advertised `/register`                                                | marketplace | Accept   |
| Axiom       | `https://mcp.axiom.co/mcp`                        | Header PRM; exact resource; same-origin issuer; S256                                               | Advertised `/register`                                                | marketplace | Accept   |
| Algolia     | `https://mcp.algolia.com/mcp`                     | Header PRM; exact resource; PRM-bound `https://dashboard.algolia.com` issuer; S256                 | Advertised `/2/oauth/register`                                        | marketplace | Accept   |
| Netlify     | `https://netlify-mcp.netlify.app/mcp`             | Header PRM; exact resource; trailing-slash-equivalent same-origin issuer; S256                     | Advertised `/oauth-server/reg`                                        | marketplace | Accept   |
| Klaviyo     | `https://mcp.klaviyo.com/mcp`                     | Well-known PRM; same-origin parent resource and issuer; S256                                       | Advertised `/register`                                                | marketplace | Accept   |
| Customer.io | `https://mcp.customer.io/mcp`                     | Header PRM; exact resource and issuer; S256; five advertised resource scopes                       | Advertised `/oauth2/register`                                         | marketplace | Accept   |
| incident.io | `https://mcp.incident.io/mcp`                     | Header PRM; same-origin parent resource; exact `/mcp` issuer; S256; advertised HTTPS app endpoints | Advertised `/mcp/oauth/register`; callback host needs admin allowlist | marketplace | Accept   |
| Tavily      | `https://mcp.tavily.com/mcp/`                     | Header PRM; trailing-slash-equivalent resource and issuer; S256                                    | Advertised `/register`                                                | marketplace | Accept   |
| Clerk       | `https://mcp.clerk.com/mcp`                       | Full no-auth MCP sequence; two listed tools; real snippet-index call                               | No client required                                                    | none        | Accept   |

### 2.1 Registry provenance, rechecked 2026-08-20

The official registry currently has active, latest records with the exact shipped name
for these seven, so they remain under `entries:`:

- `com.postman/postman-mcp-server`
- `io.github.miroapp/mcp-server`
- `io.github.algolia/algolia-productivity`
- `io.github.cloudinary/asset-management-mcp`
- `io.github.clerk/mcp-server`
- `co.axiom/mcp`
- `io.github.tavily-ai/tavily-mcp`

No exact registry record exists for the inferred names `com.netlify/mcp`,
`com.klaviyo/mcp`, `io.customer/mcp`, or `io.incident/mcp`; those four remain under
`unpublished:`. Tavily's official package also declares
`mcpName: "io.github.tavily-ai/tavily-mcp"`; the earlier inferred `com.tavily/mcp`
identity was wrong and has been removed. The resulting catalog split is 31 published /
20 unpublished. This is provenance, not a quality tier.

### 2.2 Curation notes

All eleven permission disclosures were rechecked against current vendor documentation
and the 2026-08-20 live metadata:

| Entry       | Disclosure review                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postman     | Expanded for the US-only OAuth Full endpoint's 100+ tools, workspace/access management, environment variables, destructive API operations, and hosted telemetry.                                                                                                                                                           |
| Cloudinary  | Retained: its documented asset-management surface uploads, searches, renames, tags, transforms, and deletes media; live resource scopes remain `asset_management upload media_generation` plus identity scopes.                                                                                                            |
| Miro        | Expanded to include acting on comments; board reach remains limited by the approving user's existing board access.                                                                                                                                                                                                         |
| Axiom       | Expanded to cover metrics queries and update authority as well as create/delete dashboards, monitors, and notifiers, query billing, and US result routing.                                                                                                                                                                 |
| Algolia     | Retained as explicitly read-only across every application/index the user can reach; official docs say data changes remain in the dashboard or APIs.                                                                                                                                                                        |
| Netlify     | Expanded for user/team information, access-control changes, extension install/removal, build logs, form submissions, and environment secrets in addition to projects/deploys/storage/databases.                                                                                                                            |
| Klaviyo     | Expanded for customer and user-generated content, destructive campaign actions and send cancellation, profile merge/import, and subscription/suppression changes.                                                                                                                                                          |
| Customer.io | Expanded for the exact five live PRM scopes—`configure read read:sensitive write write:live`—and their full Journeys/CDP authority. Agor requests all five; provider consent, user role, and admin toggles still constrain the grant. The catalog URL is explicitly US-only; Customer.io's separate EU URL is not modeled. |
| incident.io | Expanded for follow-ups, investigations, post-mortems/archives, and connected observability logs, metrics, traces, and dashboards; also states the admin callback-host allowlisting prerequisite users need before Agor can authorize.                                                                                     |
| Tavily      | Updated under its official Registry identity; disclosure covers submitted queries/URLs, account usage, and the live `openid offline_access` session scopes. Tools remain public-web search/extraction only.                                                                                                                |
| Clerk       | Retained: live `tools/list` and `list_clerk_sdk_snippets` expose public snippet bundles, not a Clerk tenant or end-user data.                                                                                                                                                                                              |

Editorial ranks remain assigned into gaps created by #2491 instead of appending stale
51–62 ranks; §11 records the exact mapping.

---

## 3. Original 2026-08-17 search-space rejections

This section preserves the original breadth-first research record. Its candidate counts are
historical, not the final-catalog delta against current `main`; §6 is authoritative for
that.

> **How to read §3.1 and §3.3 — READ THIS BEFORE COPYING ANY URL FROM THEM.**
>
> Everything in §2 is probed and shipped. Everything in §3 is **not shipped**,
> and much of it is **not probed either**. Many rows below name a corrected URL
> — a host or path a vendor's documentation gives, which my probe never
> touched. Those are leads, not findings, and they are labelled:
>
> - **`UNVERIFIED CANDIDATE`** — a real documented URL that nothing here has
>   dialled. It may 404, need a key, or not be an MCP server at all. Before it
>   can enter `curated.yaml`, OAuth candidates need the complete §1 boundary
>   audit and no-auth candidates need §10's tools-actually-work audit.
> - **`NOT A CANDIDATE`** — per-tenant or templated, so there is no fixed URL a
>   static catalogue could ever carry. Not worth re-researching.
>
> §3.3 is different again: those endpoints _were_ probed, but against the
> `initialize` bar only, before §10 existed.
>
> Copying an unprobed URL out of a document full of probed ones is precisely
> how this file came to assert, falsely, that all 48 endpoints had been reached
> unauthenticated. Do not restart that.

### 3.1 Rejected — host does not resolve or endpoint does not answer (`unreachable`)

Every one of these was a plausible `mcp.<vendor>` guess or a recollected URL.
All were probed once; `unreachable` at single-digit ms is DNS failure, higher
values are connection failure or a non-2xx.

**Every corrected URL in the right-hand column is an `UNVERIFIED CANDIDATE`.**
The verdict column applies to the endpoint in the "Endpoint probed" column and
to nothing else.

| Vendor        | Endpoint probed                    | Verdict     | Reason rejected                                                                                                                                  |
| ------------- | ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pinecone      | `https://mcp.pinecone.io/mcp`      | unreachable | host does not resolve; real endpoint is per-assistant, `<ASSISTANT_HOST>/mcp/assistants/<NAME>` — **NOT A CANDIDATE**: no fixed URL to catalogue |
| Perplexity    | `https://mcp.perplexity.ai/mcp`    | unreachable | host does not resolve; docs now name `api.perplexity.ai/mcp` (bearer only) — **UNVERIFIED CANDIDATE**, not probed                                |
| Twilio        | `https://mcp.twilio.com/mcp`       | unreachable | wrong path — the real one is `mcp.twilio.com/docs`, which WAS probed 3x (`none`) and is in §3.3                                                  |
| LaunchDarkly  | `https://mcp.launchdarkly.com/mcp` | unreachable | real path is `/mcp/launchdarkly`, not retried — **UNVERIFIED CANDIDATE**, not probed                                                             |
| Snyk          | `https://mcp.snyk.io/mcp`          | unreachable | Snyk states outright it offers no hosted remote server                                                                                           |
| Upstash       | `https://mcp.upstash.io/mcp`       | unreachable | stdio only                                                                                                                                       |
| Jina AI       | `https://mcp.jina.ai/mcp`          | unreachable | real path is `/v1`, not retried — **UNVERIFIED CANDIDATE**, not probed                                                                           |
| Elastic       | `https://mcp.elastic.co/mcp`       | unreachable | per-deployment (`{KIBANA_URL}/api/agent_builder/mcp`) — **NOT A CANDIDATE**: no fixed URL to catalogue                                           |
| Redis         | `https://mcp.redis.io/mcp`         | unreachable | stdio only                                                                                                                                       |
| Zendesk       | `https://mcp.zendesk.com/mcp`      | unreachable | per-tenant (`{subdomain}.zendesk.com/api/mcp`); no vendor endpoint doc exists — **NOT A CANDIDATE**: no fixed URL to catalogue                   |
| Plaid         | `https://mcp.plaid.com/mcp`        | unreachable | real host is `api.dashboard.plaid.com/mcp/`, client-credentials only — **UNVERIFIED CANDIDATE**, not probed                                      |
| Shopify (dev) | `https://mcp.shopify.dev/mcp`      | unreachable | no such host                                                                                                                                     |
| Fly.io        | `https://mcp.fly.io/mcp`           | unreachable | stdio only, binds 127.0.0.1                                                                                                                      |
| DigitalOcean  | `https://mcp.digitalocean.com/mcp` | unreachable | nine per-service hosts, `<svc>.mcp.digitalocean.com`, bearer-token only — **NOT A CANDIDATE**: no fixed URL to catalogue                         |
| Railway       | `https://mcp.railway.com/mcp`      | unreachable | real URL is the bare `https://mcp.railway.com/` — **UNVERIFIED CANDIDATE**, not probed                                                           |
| Doppler       | `https://mcp.doppler.com/mcp`      | unreachable | no vendor-documented remote endpoint found                                                                                                       |
| Statsig       | `https://mcp.statsig.com/mcp`      | unreachable | real URL is `api.statsig.com/v1/mcp` — **UNVERIFIED CANDIDATE**, not probed                                                                      |
| Front         | `https://mcp.front.com/mcp`        | unreachable | real host is `mcp.frontapp.com`; needs a pre-registered confidential client — **UNVERIFIED CANDIDATE**, not probed                               |
| Calendly      | `https://mcp.calendly.com/mcp`     | unreachable | real URL is the bare `https://mcp.calendly.com` — **UNVERIFIED CANDIDATE**, not probed                                                           |
| Gusto         | `https://mcp.gusto.com/mcp`        | unreachable | only an Embedded-partner docs assistant exists                                                                                                   |
| Coda          | `https://mcp.coda.io/mcp`          | unreachable | moved to `docs.superhuman.com/apis/mcp` mid-rebrand — **UNVERIFIED CANDIDATE**, not probed                                                       |
| Todoist       | `https://mcp.todoist.com/mcp`      | unreachable | real host is `ai.todoist.net/mcp` — **UNVERIFIED CANDIDATE**, not probed                                                                         |
| Better Stack  | `https://mcp.betterstack.com/mcp`  | unreachable | real URL is the bare `https://mcp.betterstack.com` — **UNVERIFIED CANDIDATE**, not probed                                                        |
| Dynatrace     | `https://mcp.dynatrace.com/mcp`    | unreachable | per-environment                                                                                                                                  |
| Turso         | `https://mcp.turso.tech/mcp`       | unreachable | real host is `mcp.turso.ai/mcp` — **UNVERIFIED CANDIDATE**, not probed                                                                           |
| PlanetScale   | `https://mcp.planetscale.com/mcp`  | unreachable | real host is `mcp.pscale.dev/mcp/planetscale` — **UNVERIFIED CANDIDATE**, not probed                                                             |
| MotherDuck    | `https://mcp.motherduck.com/mcp`   | unreachable | real URL is `api.motherduck.com/mcp` — **UNVERIFIED CANDIDATE**, not probed                                                                      |
| Metabase      | `https://mcp.metabase.com/mcp`     | unreachable | per-instance (`{your-metabase}/api/metabase-mcp`) — **NOT A CANDIDATE**: no fixed URL to catalogue                                               |
| dbt Labs      | `https://mcp.getdbt.com/mcp`       | unreachable | per-tenant (`{DBT_HOST}/api/ai/v1/mcp/`) plus required headers — **NOT A CANDIDATE**: no fixed URL to catalogue                                  |
| ElevenLabs    | `https://mcp.elevenlabs.io/mcp`    | unreachable | real URL is `api.elevenlabs.io/v1/mcp` — **UNVERIFIED CANDIDATE**, not probed                                                                    |
| Modal         | `https://mcp.modal.com/mcp`        | unreachable | Modal documents only how to host your own; no vendor server                                                                                      |
| Braintrust    | `https://mcp.braintrust.dev/mcp`   | unreachable | real URL is `api.braintrust.dev/mcp` (EU: `api-eu.`) — **UNVERIFIED CANDIDATE**, not probed                                                      |

Several of these are "wrong path, real server" rather than "no server". They are
listed with the corrected URL so the next pass starts from it rather than
re-deriving it — but a corrected URL is a **candidate, not a finding**: none of
them has been probed, so none may be added without going through §1 first.

### 3.2 Rejected — probed clean, but rejected on curation grounds

These are the interesting ones. All three answered a valid unauthenticated
`initialize`, so the probe alone would have installed them.

| Vendor      | Endpoint probed                   | r1   | r2   | r3   | Why rejected anyway                                                                                                                                                                                                                                                                |
| ----------- | --------------------------------- | ---- | ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browserbase | `https://mcp.browserbase.com/mcp` | none | none | none | **The handshake lies.** Browserbase's own setup doc requires `?browserbaseApiKey=` for _tool calls_; `initialize` succeeds without it. Shipping this as `auth_type: none` puts a Connect button in front of users that succeeds and then attaches a server whose every tool fails. |
| Convex      | `https://mcp.convex.dev/mcp`      | none | none | —    | Something answers, but **no Convex documentation names this host.** `docs.convex.dev/ai/convex-mcp-server` documents only `npx convex mcp start` (stdio). An undocumented endpoint can be withdrawn without notice.                                                                |
| Storyblok   | `https://mcp.storyblok.com/mcp`   | none | none | —    | Same shape as Browserbase. Storyblok's documented host is **`mcp.labs.storyblok.com/mcp`** and it requires a personal access token; `mcp.storyblok.com` is not the documented endpoint.                                                                                            |

Browserbase is the specific failure mode this catalog should keep in mind: a
`none` verdict means _the handshake was accepted_, not _the server is usable
without an account_. The probe cannot tell those apart, so curation has to.

### 3.3 Deferred — probed and documented, but not shipped this round

These passed the original initialize probe and documentation review. They were left out
of the original August 17 pass and were not reconsidered for this finalization because
the task was to validate the proposed PR entries against the newer OAuth boundary, not
expand its candidate set.

**They are still not clearable for paste.** Every one of them predates §10, so
none has been checked for the Browserbase failure mode. The three that probe
`none` in particular — and any future candidate that does — must go through
§10's tools-actually-work check before shipping, not just an initialize handshake. Rows
whose "Category it would fill" column flags a URL disagreement are
`UNVERIFIED CANDIDATE` on that alternate URL.

| Vendor                | Endpoint                         | Runs | Verdict     | Category it would fill                                                                                                                        |
| --------------------- | -------------------------------- | ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkOS                | `https://mcp.workos.com/mcp`     | 3    | oauth       | dev-tools; registry `com.workos/mcp` → `entries:`                                                                                             |
| Attio                 | `https://mcp.attio.com/mcp`      | 2    | oauth       | productivity / crm                                                                                                                            |
| Typeform              | `https://api.typeform.com/mcp`   | 3    | oauth       | productivity                                                                                                                                  |
| Rootly                | `https://mcp.rootly.com/mcp`     | 2    | oauth       | observability; registry `com.rootly/mcp-server`                                                                                               |
| Expo                  | `https://mcp.expo.dev/mcp`       | 2    | oauth       | dev-tools                                                                                                                                     |
| GitBook               | `https://mcp.gitbook.com/mcp`    | 2    | oauth       | dev-tools / docs                                                                                                                              |
| Replicate             | `https://mcp.replicate.com/mcp`  | 2    | oauth       | data-storage                                                                                                                                  |
| Xero                  | `https://mcp.xero.com/mcp`       | 2    | oauth       | productivity / payments — **but** Xero's own docs describe a stdio server only. Probe and docs disagree; do not ship until resolved.          |
| Fireflies             | `https://mcp.fireflies.ai/mcp`   | 2    | oauth       | productivity — docs name `api.fireflies.ai/mcp`; probed host differs                                                                          |
| Braze                 | `https://mcp.braze.com/mcp`      | 3    | oauth       | messaging — Early Access, allowlist-gated, will fail to connect for most                                                                      |
| Loops                 | `https://mcp.loops.so`           | 3    | oauth       | messaging; registry `io.github.loops-so/loops`                                                                                                |
| Twilio (docs)         | `https://mcp.twilio.com/docs`    | 3    | **none**    | dev-tools / docs — genuinely open, read-only spec search, no account. A good future no-auth entry.                                            |
| Shopify               | `https://mcp.shopify.com/mcp`    | 2    | credentials | Answers, but no Shopify doc names this host; their documented servers are stdio or per-shop. Treat as unverified.                             |
| Contentful            | `https://mcp.contentful.com/mcp` | 2    | credentials | productivity / content-cms — documented, but `credentials` has no connect path yet                                                            |
| Cloudinary (2nd host) | `https://mcp.cloudinary.com/mcp` | 2    | credentials | superseded by the asset-management host we shipped                                                                                            |
| Pipedrive             | `https://mcp.pipedrive.com/mcp`  | 1    | credentials | docs name `mcp.pipedrive.ai/mcp` — different host                                                                                             |
| DocuSign              | `https://mcp.docusign.com/mcp`   | 1    | credentials | only the dev/demo host `mcp-d.docusign.com` is documented                                                                                     |
| Smartsheet            | `https://mcp.smartsheet.com/mcp` | 1    | credentials | documented URL is the bare host                                                                                                               |
| Bright Data           | `https://mcp.brightdata.com/mcp` | 3    | oauth       | search — docs document only `?token=` in the query string; the OAuth challenge the probe sees is undocumented. Deferred rather than rejected. |
| Mandrill (Mailchimp)  | `https://mandrillapp.com/mcp`    | 1    | **unknown** | rejected outright — `unknown` is disqualifying per §1                                                                                         |
| Linkup                | `https://mcp.linkup.so/mcp`      | 1    | **unknown** | rejected outright                                                                                                                             |

---

### 3.4 Final OAuth-boundary rejection — Render

Render was in the original twelve but is **not shipped**. The 2026-08-20 live metadata
and direct-core audit constructed a placeholder-client authorization URL through
protected-resource and authorization-server discovery, with exact resource/issuer
binding and advertised PKCE S256. Its live metadata has no `registration_endpoint`.
Render's documentation gives the
public client IDs `claude` and `codex` to those named clients; neither is a reviewed Agor
client and neither establishes that Agor's deployment-specific callback URI is registered.
Borrowing one would cross the client/redirect boundary that #2491 made explicit. No DCR
request was sent and no provider-side client was created.

**Decision:** reject `com.render/mcp` until Render advertises DCR or explicitly provides
a public client whose redirect contract includes Agor.

---

## 4. Vendors from the hypothesis list that were wrong

Asked for explicitly. Of the 40 vendors suggested:

**Already in the original research baseline** — Atlassian, Cloudflare, Vercel,
Zapier, Asana, ClickUp, Monday, Intercom, HubSpot, Webflow, Canva, Figma, Neon,
Supabase, Box, Dropbox, GitLab, PayPal, Square, Datadog, Grafana, and MongoDB.
#2491 subsequently removed HubSpot, Box, and MongoDB; this branch preserves those
removals.

**No remote MCP server exists** — the recollections that were wrong:

| Vendor           | What is actually true                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis**        | stdio only.                                                                                                                                                                                                                                           |
| **Perplexity**   | No `mcp.perplexity.ai`. Current docs name `api.perplexity.ai/mcp`, bearer token only — no OAuth, no browser flow.                                                                                                                                     |
| **Brave Search** | stdio only. No hosted endpoint in any Brave doc.                                                                                                                                                                                                      |
| **Pinecone**     | No remote endpoint.                                                                                                                                                                                                                                   |
| **Snowflake**    | Per-account (`<account>.snowflakecomputing.com`), unusable in a static catalog.                                                                                                                                                                       |
| **Databricks**   | Per-workspace.                                                                                                                                                                                                                                        |
| **Elastic**      | Per-deployment, under your own Kibana URL.                                                                                                                                                                                                            |
| **Salesforce**   | `api.salesforce.com/platform/mcp/v1/<SERVER-NAME>` — fixed domain but org-configured path, and requires an org admin to create an External Client App first. Not connectable from a catalog.                                                          |
| **Zendesk**      | Per-tenant. Zendesk announced a server at Relate 2026 but ships only an MCP _client_ today.                                                                                                                                                           |
| **Plaid**        | Real, but `api.dashboard.plaid.com/mcp/` with OAuth **client-credentials** (15-minute tokens), not a browser flow — and it exposes only dashboard telemetry, never end-user banking data.                                                             |
| **Twilio**       | The only Twilio endpoint is `mcp.twilio.com/docs`, a public docs search. No account-scoped server; execute tools are "planned".                                                                                                                       |
| **Shopify**      | Dev MCP is stdio; Storefront MCP is `{shop}.myshopify.com/api/mcp`, per-tenant. No `mcp.shopify.com` appears in any Shopify document — despite that host answering.                                                                                   |
| **Bitbucket**    | No Bitbucket endpoint. It rides on the Atlassian server already in the catalog, and its tools work **only** under API-token auth — an OAuth connect exposes no Bitbucket tools at all. A separate shelf item would be the same URL and would collide. |
| **Miro**         | Correct, and now shipped — but the endpoint is the bare `https://mcp.miro.com/`, not `/mcp`.                                                                                                                                                          |
| **Netlify**      | Correct, but the endpoint is **`netlify-mcp.netlify.app/mcp`**. See §5.                                                                                                                                                                               |

---

## 5. Where the documented endpoint and the working endpoint differed

Five cases, all worth recording:

1. **Netlify — shipped the documented one over the guessable one.**
   `https://mcp.netlify.com/mcp` answers `oauth` on all three runs. No Netlify
   page names it. The documented endpoint is
   `https://netlify-mcp.netlify.app/mcp`, which also answers `oauth` on three
   runs. Both work; the entry ships the documented one, because a host the
   vendor never wrote down is a host the vendor never promised to keep.

2. **Miro — path matters.** `https://mcp.miro.com/mcp` answers `oauth`, but the
   registry record and the docs both name the bare `https://mcp.miro.com/`.
   Shipped the documented form.

3. **Tavily — trailing slash.** Docs name `https://mcp.tavily.com/mcp/`.
   Both forms answer `oauth`; shipped the documented one, probed twice on its
   own to be sure the slash changed nothing.

4. **Postman and Cloudinary — the registry understates the auth.** Both
   registry records declare only secret `headers` (a Postman API key; Cloudinary
   cloud-name/key/secret), which reads as `credentials`. Both endpoints answer
   with an OAuth challenge on five and five runs respectively, and both vendors'
   docs confirm OAuth is now the recommended path. `auth_type: oauth` is the
   probe's answer and the docs' answer; the registry metadata is stale.

5. **Firecrawl — corrected the old alias.** The prior catalog used the working but
   undocumented `https://mcp.firecrawl.dev/mcp` alias. Current docs name
   `https://mcp.firecrawl.dev/v2/mcp`; the catalog now uses that versioned URL and a
   real no-auth scrape passed there (§10.5).

One near-miss worth the same treatment: **Storyblok's** documented host
(`mcp.labs.storyblok.com`) and the host that answers openly
(`mcp.storyblok.com`) are different servers with different auth. Rejected — see
§3.2.

---

## 6. Final counts against current `origin/main`

All catalog entries on current `main` and on this branch are installable; there are no
package-only rows. Counts are reported here for review, not asserted as brittle exact
whole-catalog tests. The loader tests continue to enforce structural invariants and the
new audit test names the reviewed entries directly.

|                                         | Current main |    Final branch |        Delta |
| --------------------------------------- | -----------: | --------------: | -----------: |
| Total / installable                     |           40 |          **51** |          +11 |
| `entries:` / `unpublished:`             |      24 / 16 |     **31 / 20** |      +7 / +4 |
| OAuth / none / credentials              |   34 / 5 / 1 |  **44 / 6 / 1** | +10 / +1 / 0 |
| dev-tools / productivity / data-storage |  12 / 11 / 6 | **15 / 12 / 7** | +3 / +1 / +1 |
| observability / search / messaging      |    7 / 3 / 1 |   **9 / 5 / 3** | +2 / +2 / +2 |

Relative to the rebased PR before the final audit, one proposed row is removed: Render.
The eight endpoints removed by #2491 remain absent.

---

## 7. Final checks

All checks were run after the final catalog, rank, and audit-test edits:

- `pnpm --filter @agor/core exec vitest run src/mcp-catalog --reporter=dot`
  — **126 passed** in four files.
- `pnpm --filter @agor/core exec vitest run src/tools/mcp/oauth-mcp-transport.test.ts --reporter=dot`
  — **85 passed**.
- `pnpm --filter @agor/daemon exec vitest run src/services/mcp-catalog-connect.test.ts src/services/mcp-catalog-connect.install.test.ts src/services/mcp-oauth-compatibility.test.ts --reporter=dot`
  — **141 passed** in three files.
- `pnpm --filter @agor/daemon exec vitest run src/register-services.oauth-sqlite.integration.test.ts --reporter=dot`
  — **15 passed**, including the new canonical-row Marketplace/DCR fixture.
- `pnpm --filter @agor/git typecheck` — passed.
- `pnpm --filter @agor/core exec tsc --noEmit --customConditions source` — passed.
- `pnpm --filter @agor/daemon exec tsc --noEmit --customConditions source` — passed.
- `pnpm check:multitenancy-boundaries` — passed.
- `pnpm lint` — passed: 2,344 files checked and 330 frontend design-system fixture
  cases passed.
- `pnpm exec prettier --check docs/internal/mcp-catalog-expansion-2026-08-17.md packages/core/src/mcp-catalog/curated.yaml`
  — passed.
- `git diff --check` — passed.

The direct core and daemon `typecheck` scripts resolve workspace dependencies from
their `dist` declarations and therefore require upstream package builds in a clean
worktree. Repository instructions prohibit running builds in the user's watch-mode
environment, so the equivalent source-export checks above use TypeScript's `source`
custom condition; they do not emit files. Focused Vitest also compiles and exercises the
changed loader contract and production OAuth path from source.

---

## 8. Final accepted set (source of truth remains `curated.yaml`)

Duplicating full YAML here made the original report drift during rebase. The checked-in
file is authoritative; this stable identity/provenance/rank index is enough to review the
curation decision without hard-coding a catalog-wide count.

| Name                                        | Provenance | Rank | Auth  |
| ------------------------------------------- | ---------- | ---: | ----- |
| `com.postman/postman-mcp-server`            | registry   |   13 | OAuth |
| `com.netlify/mcp`                           | inferred   |   16 | OAuth |
| `io.github.miroapp/mcp-server`              | registry   |   18 | OAuth |
| `io.github.tavily-ai/tavily-mcp`            | registry   |   27 | OAuth |
| `io.github.algolia/algolia-productivity`    | registry   |   40 | OAuth |
| `io.github.cloudinary/asset-management-mcp` | registry   |   46 | OAuth |
| `io.github.clerk/mcp-server`                | registry   |   50 | none  |
| `co.axiom/mcp`                              | registry   |   51 | OAuth |
| `com.klaviyo/mcp`                           | inferred   |   52 | OAuth |
| `io.customer/mcp`                           | inferred   |   53 | OAuth |
| `io.incident/mcp`                           | inferred   |   54 | OAuth |

---

## 10. Audit of the six `auth_type: none` entries

Added 2026-08-18 and rechecked on 2026-08-20 after rebasing onto current `main`.

The Browserbase rejection in §3.2 rests on a claim that applies to the catalog
as it already stands, not only to what it refused: **a `none` verdict means the
handshake was accepted, not that the server is usable without an account.**
#2491 now makes reviewed catalog OAuth entries installable, but the Browserbase
shape remains a catalog-integrity defect: Connect could still install a server whose
handshake succeeds while every useful tool fails.

### 10.1 What was tested, and what it does and does not establish

`initialize` is not evidence; that is the whole point of §3.2. So for each of
the six I ran the full client sequence — `initialize` → `notifications/initialized`
→ `tools/list` → **one `tools/call`** with benign, read-only arguments, no
credentials, and read the vendor's documentation alongside it.

What a successful `tools/call` establishes: the server accepted an
unauthenticated caller, dispatched a real tool, and returned real data. That is
materially stronger than a handshake and stronger than `tools/list` (which
Browserbase would also pass — it advertises its tools before refusing to run
them).

What it does **not** establish:

- **That it will keep working.** Every one of these is a free tier the vendor
  can change, and four of the six say so in their own docs.
- **That every tool works.** One tool was called per server, chosen to be cheap
  and read-only. A server could gate its expensive tools differently.
- **That it works at volume.** Two of the six returned quota language
  unprompted. A user hitting a rate limit sees tool failures that look exactly
  like the Browserbase failure mode, just later.

### 10.2 Results — all six pass

| Entry                          | `tools/list` | Tool called (benign args)                                             | Result                                                              | Verdict            |
| ------------------------------ | ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ |
| `com.context7/mcp`             | 2 tools      | `resolve-library-id` (`query: "react hooks"`, `libraryName: "react"`) | Returned a real library index — `/reactjs/react.dev`, 6064 snippets | **Genuinely open** |
| `com.deepwiki/mcp`             | 3 tools      | `read_wiki_structure` (`modelcontextprotocol/servers`)                | Returned the real wiki page tree                                    | **Genuinely open** |
| `co.huggingface/hf-mcp-server` | 4 tools      | `hub_repo_search` (`query: "bert"`, `limit: 1`)                       | Returned `google-bert/bert-base-cased` with live download counts    | **Genuinely open** |
| `ai.exa/exa`                   | 2 tools      | `web_search_exa` (`"model context protocol"`, 1 result)               | Returned a real search hit with page highlights                     | **Genuinely open** |
| `com.firecrawl/mcp`            | 3 tools      | `firecrawl_scrape` (`https://example.com`)                            | Returned scraped markdown + metadata                                | **Genuinely open** |
| `io.github.clerk/mcp-server`   | 2 tools      | `list_clerk_sdk_snippets` (no args)                                   | Returned the real snippet bundle index                              | **Genuinely open** |

On 2026-08-20 Clerk was re-run through `initialize` →
`notifications/initialized` → `tools/list` → `list_clerk_sdk_snippets`: 200/202/200/200,
two tools, a 3,147-byte real snippet index, and no tool error. The other five retain the
2026-08-18 evidence below.

**None of the six is Browserbase-shaped.** Every one dispatched a real tool
unauthenticated and returned real data. The commercial ones you were right to
suspect — Exa and Firecrawl — both run a documented keyless tier rather than a
handshake that leads nowhere.

Two methodology notes, so the table is not read as cleaner than it was:

- Context7's first two calls failed with `Input validation error`. That was my
  error, not a refusal — its schema requires **both** `query` and `libraryName`,
  and I sent one each time. The third call, with both, succeeded. A wrong
  argument and an auth refusal are not the same thing, and a validation error
  arriving at all is itself weak evidence the call was authorised enough to be
  validated.
- Hugging Face's first call was `hf_whoami`, which is the auth-status tool and
  therefore the tool most likely to answer anonymously — too weak to conclude
  from. It did return a useful admission, quoted below, but the verdict above
  rests on the second call to `hub_repo_search`, which is a substantive tool.

### 10.3 What the vendors say — every one documents the keyless tier

The docs agree with the probes, which is the outcome that matters: this is
designed behaviour, not an oversight to be caught later.

- **Hugging Face** — the server says it in-band, unprompted:
  _"The Hugging Face tools are being used anonymously and may be rate limited.
  … create a free account and enjoy higher rate limits."_
- **Exa** — _"Exa MCP's free plan covers casual use."_ On exhaustion: 429 with
  _"You've hit the free plan rate limit. Add your own API key to continue."_
  Keys go in an `x-api-key` **header**, not the URL.
- **Firecrawl** — keyless access is one of three documented paths, giving
  _"Search, Scrape, and Parse within daily limits."_ The docs also say the key
  must never go in the MCP URL.
- **Context7** — works without a key at an anonymous rate limit; a free key
  raises limits and adds private-repo access. Community issues report the
  anonymous limit biting in practice (~1,000 calls/month, 20/day while blocked).
- **DeepWiki** — free, no authentication, public repositories only. Private
  repos require the separate Devin MCP server and a Devin API key.
- **Clerk** — a documentation server: two tools, public content, no tenant data.

Four are metered keyless tiers and two are open public-documentation services.
That distinction is the recommendation below.

### 10.4 Recommendation — do not flip any value; the schema is missing a state

Per your instruction I changed nothing. My recommendation is that **no
`auth_type` value here is wrong and none should be flipped.** `none` is the
honest answer to the question `auth_type` actually asks — "what does this
endpoint require of a client in order to connect" — and for all six the answer
is genuinely "nothing".

The gap is that `auth_type` is being asked to carry a second question it was
never defined to answer: _how well does this work without an account?_ Today's
four values cannot distinguish:

1. **Open and complete** — Clerk, DeepWiki. No account exists to have; a key
   would buy nothing.
2. **Open but metered** — Context7, Exa, Firecrawl, Hugging Face. Full tool
   surface, free tier, and a key lifts limits or unlocks private data.
3. **Open handshake, closed tools** — Browserbase, Storyblok. Connect succeeds;
   every tool fails. **Currently indistinguishable from 1 and 2**, which is why
   §3.2 had to be a human judgement rather than a rule.

Categories 1 and 2 are both fine to ship and the difference is a curation-copy
matter — arguably `permission_disclosure` should mention metering, as Tavily's
does, and Context7's and Firecrawl's currently do not. It is
category 3 that is dangerous, and it is dangerous precisely because nothing in
the file or the probe can express it.

Three options, in the order I would consider them:

- **Cheapest, and worth doing regardless:** extend the connect-time probe from
  `initialize` to `initialize` + `tools/list` + optionally one tool call. This
  catches nothing today — all six pass — but it is the only mechanical defence
  against a category-3 entry being added later, or a category-2 vendor sliding
  into category 3 when it monetises. Note it does not catch a metered server
  whose quota is exhausted, which will look like category 3 at connect time.
- **A curation field**, e.g. `free_tier: complete | metered` alongside
  `auth_type`, stated by the entry and shown in the marketplace. Honest, cheap,
  reviewable — but it is another hand-maintained claim about a third party that
  the file cannot keep current, which is the failure this catalog already had
  once.
- **Do nothing to the schema**, and keep §3.2 as a curation rule enforced by
  review. Fine while a human reviews every addition; it fails silently the day
  the catalog admits entries nobody vetted.

#2491 has since landed the bounded Marketplace OAuth mode. That reduces the product
impact of a bad `none` classification, but it does not remove the need for the
tools-actually-work curation check.

### 10.5 Firecrawl URL correction

`com.firecrawl/mcp` now ships Firecrawl's documented versioned keyless URL,
`https://mcp.firecrawl.dev/v2/mcp`, rather than the still-live but undocumented
`/mcp` alias. On 2026-08-20 the versioned URL returned `none`, initialized as
`firecrawl-fastmcp` 3.24.0, listed exactly `firecrawl_scrape`, `firecrawl_search`, and
`firecrawl_parse`, and completed a real unauthenticated scrape of `https://example.com`.
The starter prompt and disclosure now match that rate-limited keyless surface rather
than promising the account-only crawl tool.

---

## 11. Editorial rank update

#2491 freed ranks 1, 13, 16, 18, 27, 40, 46, and 50. Rather than leave every
addition below the old tail, this finalization uses seven of those conservative insertion
points and then appends the four most specialist vendors. No existing entry is renumbered.

| Entry       | Old proposal | Final | Rationale                                   |
| ----------- | -----------: | ----: | ------------------------------------------- |
| Postman     |           52 |    13 | mainstream API-development platform         |
| Netlify     |           51 |    16 | mainstream deployment platform              |
| Miro        |           53 |    18 | mainstream collaboration/design platform    |
| Tavily      |           54 |    27 | prominent agent-search provider             |
| Algolia     |           55 |    40 | established search platform, specialist MCP |
| Cloudinary  |           57 |    46 | established media platform, specialist MCP  |
| Clerk       |           58 |    50 | focused public documentation server         |
| Axiom       |           59 |    51 | specialist observability platform           |
| Klaviyo     |           60 |    52 | specialist marketing platform               |
| Customer.io |           61 |    53 | specialist marketing platform               |
| incident.io |           62 |    54 | specialist incident platform                |

Rank 1 intentionally remains vacant rather than promoting a new entry to GitHub's former
position without comparable install-volume evidence. Rank remains editorial metadata,
not a measured Agor install count.

---

## 12. Vendor and registry sources (rechecked 2026-08-20)

- [Postman remote MCP](https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server)
- [Cloudinary MCP and AI agent tools](https://cloudinary.com/documentation/cloudinary_llm_mcp)
- [Miro MCP](https://developers.miro.com/docs/miro-mcp)
- [Axiom MCP](https://axiom.co/docs/console/intelligence/mcp-server)
- [Algolia Productivity MCP](https://www.algolia.com/doc/guides/model-context-protocol/productivity-mcp)
- [Netlify MCP setup](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/#mcp-server-support)
- [Netlify official MCP capability list](https://github.com/netlify/netlify-mcp#use-cases)
- [Klaviyo MCP](https://developers.klaviyo.com/en/docs/klaviyo_mcp_server)
- [Customer.io MCP](https://docs.customer.io/ai/mcp/get-started/)
- [incident.io remote MCP](https://docs.incident.io/ai/remote-mcp)
- [Tavily MCP](https://docs.tavily.com/documentation/mcp)
- [Tavily official package identity](https://github.com/tavily-ai/tavily-mcp/blob/main/package.json)
- [Clerk MCP](https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server)
- [Render MCP — rejected](https://render.com/docs/mcp-server)
- [Official MCP Registry API](https://registry.modelcontextprotocol.io/v0.1/servers)
- [Firecrawl MCP setup](https://github.com/firecrawl/firecrawl-docs/blob/main/mcp-server.mdx)
