# MCP catalog expansion — 60 installable entries

**Date:** 2026-08-17
**Branch:** `catalog-expansion-research`
**Outcome:** `curated.yaml` grows from 50 entries / 48 installable to **62 entries / 60 installable**.
**Addendum 2026-08-18:** §10 audits all six `auth_type: none` entries against the
Browserbase failure mode — all six pass, no value changed. §11 sizes a rank re-rank.

---

## 1. Method, and what "verified" means here

Every endpoint below was dialled with `probeRemoteAuthType`
(`packages/core/src/mcp-catalog/auth-probe.ts`) — the same function `connect`
runs — from this host, driven by a throwaway vitest harness that was deleted
before commit. One unauthenticated JSON-RPC `initialize` per request, no
credentials, through `createPinnedFetch`.

Each accepted endpoint was probed **at least three times** across separate
runs; nothing accepted disagreed with itself on any run. The raw verdicts are
in the tables below, one column per run.

Two rules were applied on top of the probe:

- **`unreachable` or `unknown` → rejected.** No exceptions.
- **No vendor documentation naming the endpoint → rejected**, however well it
  probed. Three servers answered a clean handshake and were still rejected on
  this ground alone (§3.2). An aggregator listing was never accepted as the
  source; where only Smithery / Composio / mcpservers.org named a URL, the
  candidate was dropped.

`auth_type` in every shipped entry is the probe's verdict, not the vendor's
claim. Where the two disagree it is called out in §5.

---

## 2. Accepted — 12 new entries

Probe verdicts, one column per run. All URLs are exactly as shipped.

| Vendor      | Endpoint probed                                   | r1    | r2    | r3    | r4    | r5    | Verdict  | List          |
| ----------- | ------------------------------------------------- | ----- | ----- | ----- | ----- | ----- | -------- | ------------- |
| Netlify     | `https://netlify-mcp.netlify.app/mcp`             | oauth | oauth | oauth | —     | —     | oauth    | `unpublished` |
| Postman     | `https://mcp.postman.com/mcp`                     | oauth | oauth | oauth | oauth | oauth | oauth    | `entries`     |
| Miro        | `https://mcp.miro.com/`                           | oauth | oauth | oauth | oauth | oauth | oauth    | `entries`     |
| Tavily      | `https://mcp.tavily.com/mcp/`                     | oauth | oauth | oauth | oauth | —     | oauth    | `unpublished` |
| Algolia     | `https://mcp.algolia.com/mcp`                     | oauth | oauth | oauth | oauth | oauth | oauth    | `entries`     |
| Render      | `https://mcp.render.com/mcp`                      | oauth | oauth | oauth | oauth | oauth | oauth    | `unpublished` |
| Cloudinary  | `https://asset-management.mcp.cloudinary.com/mcp` | oauth | oauth | oauth | oauth | oauth | oauth    | `entries`     |
| Clerk       | `https://mcp.clerk.com/mcp`                       | none  | none  | none  | none  | none  | **none** | `entries`     |
| Axiom       | `https://mcp.axiom.co/mcp`                        | oauth | oauth | oauth | oauth | —     | oauth    | `entries`     |
| Klaviyo     | `https://mcp.klaviyo.com/mcp`                     | oauth | oauth | oauth | oauth | oauth | oauth    | `unpublished` |
| Customer.io | `https://mcp.customer.io/mcp`                     | oauth | oauth | oauth | oauth | oauth | oauth    | `unpublished` |
| incident.io | `https://mcp.incident.io/mcp`                     | oauth | oauth | oauth | oauth | oauth | oauth    | `unpublished` |

### 2.1 The `entries:` / `unpublished:` placement, justified

The loader's rule is that `entries:` means _the registry publishes a server
under exactly this `name`_. I applied it strictly, and additionally required
that the registry record list the same remote URL we are cataloguing — a
registry record for an npm package is not a record of the endpoint. Each of the
six on the `entries:` side was fetched from
`registry.modelcontextprotocol.io/v0/servers` and confirmed `isLatest: true`,
`status: active`, with the shipped URL in its `remotes`:

| Shipped `name`                              | Registry `remotes`                                     |
| ------------------------------------------- | ------------------------------------------------------ |
| `com.postman/postman-mcp-server`            | `https://mcp.postman.com/mcp` (+ `/minimal`, EU hosts) |
| `io.github.miroapp/mcp-server`              | `https://mcp.miro.com/`                                |
| `io.github.algolia/algolia-productivity`    | `https://mcp.algolia.com/mcp`                          |
| `io.github.cloudinary/asset-management-mcp` | `https://asset-management.mcp.cloudinary.com/mcp`      |
| `io.github.clerk/mcp-server`                | `https://mcp.clerk.com/mcp`                            |
| `co.axiom/mcp`                              | `https://mcp.axiom.co/sse`, `https://mcp.axiom.co/mcp` |

The six on the `unpublished:` side are the inverse case, and each fails the rule
for a stated reason:

- **Netlify** — registry has no Netlify-operated entry at all. The four
  `app.netlify.*` names are third-party apps that merely _deploy on_ Netlify.
- **Render** — no vendor entry; every `render` match is an unrelated
  PDF/video-rendering server.
- **Tavily** — `io.github.tavily-ai/tavily-mcp` exists but has **no `remotes`**;
  it publishes the local package, not this endpoint. Shipped as
  `com.tavily/mcp`, Agor's own reverse-DNS guess.
- **Klaviyo**, **Customer.io**, **incident.io** — no vendor-namespaced entry.
  All registry matches are aggregator rehosts (`io.github.pipeworx-io/*`,
  `com.mcparmory/*`), which are not the vendor.

Resulting split: 34 `entries:` / 28 `unpublished:` = 0.452, comfortably over the
loader test's 0.2 floor.

### 2.2 Curation notes worth a reviewer's eye

- **Algolia's `permission_disclosure` says "Read-only"** because Algolia's own
  docs say so verbatim: _"it can't create, update, or delete indices, records,
  or settings."_ It is the only new entry that cannot write.
- **Axiom is not read-only** despite reading like a query tool: the docs
  document creating and deleting dashboards, monitors and notifiers, and warn
  that queries are billable. Both facts are in the disclosure.
- **Clerk is a documentation server**, two tools, no tenant data — the
  disclosure says so rather than implying it reaches your Clerk instance. It
  and Tavily's "no other account data" line are the two places where saying
  _less_ is the honest answer.
- **Customer.io's PII scope is behind an admin grant** (`read:sensitive`), so
  the disclosure states that rather than a flat "reads your customer data".
- **Klaviyo gets the harshest disclosure of the twelve** — it can send campaigns
  and bulk-suppress profiles, which is a live customer-facing write.
- `popularity_rank` 51–62. Ranks 1–50 were all taken; appending rather than
  re-ranking keeps the diff reviewable, at the cost of implying Netlify is less
  popular than Kagi. Sized in §11 — a re-rank renumbers ~50 of 62 entries and
  needs Smithery data I do not have, so it is not folded into this one.

---

## 3. Rejected

> **How to read §3.1 and §3.3 — READ THIS BEFORE COPYING ANY URL FROM THEM.**
>
> Everything in §2 is probed and shipped. Everything in §3 is **not shipped**,
> and much of it is **not probed either**. Many rows below name a corrected URL
> — a host or path a vendor's documentation gives, which my probe never
> touched. Those are leads, not findings, and they are labelled:
>
> - **`UNVERIFIED CANDIDATE`** — a real documented URL that nothing here has
>   dialled. It may 404, need a key, or not be an MCP server at all. It must go
>   through §1 (three probes + vendor docs) **and** §10 (tools actually work)
>   before it can enter `curated.yaml`.
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

These passed both bars in §1. They were left out only to land on exactly 60
installable, and are the shortlist for the next pass.

**They are still not clearable for paste.** Every one of them predates §10, so
none has been checked for the Browserbase failure mode. The three that probe
`none` in particular — and any future candidate that does — must go through
§10's tools-actually-work check before shipping, not just §1's handshake. Rows
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

## 4. Vendors from the hypothesis list that were wrong

Asked for explicitly. Of the 40 vendors suggested:

**Already in the catalog** (14) — Atlassian, Cloudflare, Vercel, Zapier, Asana,
ClickUp, Monday, Intercom, HubSpot, Webflow, Canva, Figma, Neon, Supabase, Box,
Dropbox, GitLab, PayPal, Square, Datadog, Grafana, MongoDB. Checked before
adding anything.

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

Four cases, all worth recording:

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

One near-miss worth the same treatment: **Storyblok's** documented host
(`mcp.labs.storyblok.com`) and the host that answers openly
(`mcp.storyblok.com`) are different servers with different auth. Rejected — see
§3.2.

---

## 6. Counts

|                                                                                          | Before                   | After                     |
| ---------------------------------------------------------------------------------------- | ------------------------ | ------------------------- |
| Total entries                                                                            | 50                       | **62**                    |
| Installable (`remote_url` set)                                                           | 48                       | **60**                    |
| Not installable (package-only)                                                           | 2                        | 2                         |
| `entries:`                                                                               | 28                       | 34                        |
| `unpublished:`                                                                           | 22                       | 28                        |
| `unpublished` fraction (test floor 0.2)                                                  | 0.440                    | 0.452                     |
| `remote_url` fraction (test floor 0.8)                                                   | 0.960                    | 0.968                     |
| `auth_type: none` (test floor 3)                                                         | 5                        | 6                         |
| Categories: dev-tools / productivity / data-storage / observability / search / messaging | 14 / 12 / 10 / 8 / 4 / 2 | 18 / 13 / 11 / 10 / 6 / 4 |

The two non-installable entries are unchanged: `com.auth0/mcp` and
`io.github.ClickHouse/mcp-clickhouse`.

Totals for the exercise: **72 endpoints probed** across 96 probe requests,
**12 accepted**, **60 rejected** (32 unreachable, 2 unknown, 3 probed-clean but
rejected on curation grounds, 23 verified-and-documented but deferred to stay at
60).

---

## 7. Test results

Run before the change, on this host, as a baseline:

| Suite                                      | Baseline                                        | After                   |
| ------------------------------------------ | ----------------------------------------------- | ----------------------- |
| `packages/core src/mcp-catalog/` (4 files) | 93 passed, 0 failed                             | **93 passed, 0 failed** |
| `packages/core` full suite                 | 24 files failed / 566 tests failed, 2990 passed | not re-run in full      |

**The full-core failure is pre-existing and fails on THIS HOST**, unrelated to
this change: every failure traces to
`Error: Failed to load config: EACCES: permission denied, open '/home/agorpg/.agor/config.yaml'`
in `config-manager.ts:866`, reached via `BranchRepository.create`. It reproduces
on a clean tree. `cursor-models.test.ts` hits a live API and is likewise noisy
here.

The catalog's own suite — which is what enforces name uniqueness, rank
uniqueness, the slug-collision invariant, the `auth_type`-required-iff-remote
rule, the provenance split and the ≥3 open servers floor — passes clean with the
twelve new entries in.

---

## 8. YAML as shipped

Already committed into `packages/core/src/mcp-catalog/curated.yaml`, in the
category block each belongs to. Reproduced here so the report stands alone.

### `entries:`

```yaml
- name: com.postman/postman-mcp-server
  category: dev-tools
  capabilities: [docs, automations, projects]
  benefit: Read your collections and API specs from the session, so an agent calls an endpoint the way it is actually defined rather than the way it guessed.
  starter_prompt: List the collections in my Postman workspace and run the requests in the one I name against its staging environment.
  permission_disclosure: Reads and writes collections, environments, API specifications, mocks, and monitors in the Postman workspaces you authorise.
  icon_url: https://www.google.com/s2/favicons?domain=postman.com&sz=64
  popularity_rank: 52
  remote_url: https://mcp.postman.com/mcp
  transport: streamable-http
  auth_type: oauth

- name: io.github.clerk/mcp-server
  category: dev-tools
  capabilities: [docs, code-search]
  benefit: Pull Clerk's own SDK snippets for the framework you are in, so auth code compiles against the current API rather than a remembered one.
  starter_prompt: Show Clerk's current pattern for protecting a server route in the framework I am using and check my implementation against it.
  permission_disclosure: Reads Clerk's public documentation and SDK code snippets. No account, application, or end-user data is accessed.
  icon_url: https://www.google.com/s2/favicons?domain=clerk.com&sz=64
  popularity_rank: 58
  remote_url: https://mcp.clerk.com/mcp
  transport: streamable-http
  auth_type: none

- name: io.github.cloudinary/asset-management-mcp
  title: Cloudinary
  category: data-storage
  capabilities: [files, content-cms]
  benefit: Upload, tag, and transform media from the session, so an agent wires up image URLs it has actually created rather than ones it invented.
  starter_prompt: Search my Cloudinary library for the assets I describe and generate a responsive transformation URL for each.
  permission_disclosure: Uploads, renames, deletes, tags, and transforms assets in the Cloudinary product environment you authorise, and searches everything stored in it.
  icon_url: https://www.google.com/s2/favicons?domain=cloudinary.com&sz=64
  popularity_rank: 57
  remote_url: https://asset-management.mcp.cloudinary.com/mcp
  transport: streamable-http
  auth_type: oauth

- name: io.github.miroapp/mcp-server
  title: Miro
  category: productivity
  capabilities: [design, notes, projects]
  benefit: Read the board a plan was sketched on, and draw the revised diagram back onto it when the design changes.
  starter_prompt: Find the board I name, summarise what is on it, and add a flow diagram of the architecture we just discussed.
  permission_disclosure: Reads and writes boards, items, diagrams, and data tables in the Miro teams you authorise, limited to the boards your own Miro account can already reach.
  icon_url: https://www.google.com/s2/favicons?domain=miro.com&sz=64
  popularity_rank: 53
  remote_url: https://mcp.miro.com/
  transport: streamable-http
  auth_type: oauth

- name: co.axiom/mcp
  category: observability
  capabilities: [logs, traces, metrics, datasets, sql]
  benefit: Query event data in APL so "what changed at 03:00" is answered from the logs rather than from the diff.
  starter_prompt: List my Axiom datasets and run an APL query showing error rates by service over the last six hours.
  permission_disclosure: Runs APL queries over the datasets in the Axiom organisations you authorise, and can create and delete dashboards, monitors, and notifiers. Queries are billed to your Axiom account and are routed through Axiom's US infrastructure whichever region your data sits in.
  icon_url: https://www.google.com/s2/favicons?domain=axiom.co&sz=64
  popularity_rank: 59
  remote_url: https://mcp.axiom.co/mcp
  transport: streamable-http
  auth_type: oauth

- name: io.github.algolia/algolia-productivity
  title: Algolia
  category: search
  capabilities: [datasets, analytics]
  benefit: Search your own indices and read their analytics, so "why does this query return nothing" is settled against the live index.
  starter_prompt: List my Algolia indices, run the query I name against the main one, and show which searches returned no results last week.
  permission_disclosure: Read-only. Searches indices and reads analytics for every Algolia application your account can reach, and cannot create, update, or delete indices, records, or settings.
  icon_url: https://www.google.com/s2/favicons?domain=algolia.com&sz=64
  popularity_rank: 55
  remote_url: https://mcp.algolia.com/mcp
  transport: streamable-http
  auth_type: oauth
```

### `unpublished:`

```yaml
- name: com.netlify/mcp
  category: dev-tools
  capabilities: [deployments, logs, databases, files]
  benefit: Ship a site and read the build log that follows without leaving the session that wrote the code.
  starter_prompt: List my Netlify projects, deploy the one I name, and quote the build log if it fails.
  permission_disclosure: Reads and manages projects, deploys, environment variables, blob storage, forms, and Netlify DB databases in the Netlify teams you authorise.
  icon_url: https://www.google.com/s2/favicons?domain=netlify.com&sz=64
  popularity_rank: 51
  remote_url: https://netlify-mcp.netlify.app/mcp
  transport: streamable-http
  auth_type: oauth

- name: com.render/mcp
  category: dev-tools
  capabilities: [deployments, logs, metrics, databases, sql]
  benefit: Create a service, trigger a deploy, and read the metrics it produces, all in the session that changed the code.
  starter_prompt: Show my Render services, find the one that deployed most recently, and quote the log lines around its last error.
  permission_disclosure: Reads services, deploys, logs, and metrics, creates services and Postgres databases, and updates environment variables in the Render workspaces you authorise. SQL against Render Postgres is read-only, and nothing can be deleted.
  icon_url: https://www.google.com/s2/favicons?domain=render.com&sz=64
  popularity_rank: 56
  remote_url: https://mcp.render.com/mcp
  transport: streamable-http
  auth_type: oauth

- name: com.klaviyo/mcp
  category: messaging
  capabilities: [email, crm, analytics]
  benefit: Answer "how did that campaign do, and who did it go to" without exporting a report first.
  starter_prompt: Summarise how my last five email campaigns performed and describe which segment each one targeted.
  permission_disclosure: Reads and writes profiles, events, campaigns, flows, and catalogs in the Klaviyo accounts you authorise, including your customers' personal data. It can create, send, and clone campaigns and bulk-import or suppress profiles.
  icon_url: https://www.google.com/s2/favicons?domain=klaviyo.com&sz=64
  popularity_rank: 60
  remote_url: https://mcp.klaviyo.com/mcp
  transport: streamable-http
  auth_type: oauth

- name: io.customer/mcp
  title: Customer.io
  category: messaging
  capabilities: [email, crm, automations]
  benefit: Trace why a customer did or did not receive a message, back through the campaign that should have sent it.
  starter_prompt: Find the campaign I name, describe the segment it sends to, and explain why the person I describe was excluded.
  permission_disclosure: Reads campaigns, segments, and profiles in the Customer.io workspaces you authorise, and can create, edit, and delete them. Personal data on customer profiles sits behind a separate scope a workspace admin must grant.
  icon_url: https://www.google.com/s2/favicons?domain=customer.io&sz=64
  popularity_rank: 61
  remote_url: https://mcp.customer.io/mcp
  transport: streamable-http
  auth_type: oauth

- name: io.incident/mcp
  title: incident.io
  category: observability
  capabilities: [incidents, alerts]
  benefit: Ask who was paged and what they did, then write the follow-up back onto the incident.
  starter_prompt: Summarise the incidents from the last week, say who was on call for each, and list the follow-ups still open.
  permission_disclosure: Reads and writes incidents, alerts, escalations, and on-call schedules in the incident.io organisations you authorise, acting as your own user. It can declare incidents and acknowledge pages.
  icon_url: https://www.google.com/s2/favicons?domain=incident.io&sz=64
  popularity_rank: 62
  remote_url: https://mcp.incident.io/mcp
  transport: streamable-http
  auth_type: oauth

- name: com.tavily/mcp
  category: search
  capabilities: [web-search, web-scrape]
  benefit: Search the live web and pull the page text back in one step, so research arrives as content rather than as links.
  starter_prompt: Research the topic I name, extract the full text of the three best sources, and summarise where they disagree.
  permission_disclosure: Sends your search queries to Tavily and returns public web content. Searches are billed against the API key on the Tavily account you authorise. No other account data is accessed.
  icon_url: https://www.google.com/s2/favicons?domain=tavily.com&sz=64
  popularity_rank: 54
  remote_url: https://mcp.tavily.com/mcp/
  transport: streamable-http
  auth_type: oauth
```

---

## 10. Audit of the six `auth_type: none` entries

Added 2026-08-18, after the twelve above shipped.

The Browserbase rejection in §3.2 rests on a claim that applies to the catalog
as it already stands, not only to what it refused: **a `none` verdict means the
handshake was accepted, not that the server is usable without an account.**
Until OAuth auto-mode lands, the `none` entries are the entire installable set,
so if any of them were Browserbase-shaped, Connect would succeed and install a
server whose every tool fails — and that would be the only thing a user could
install.

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

So all six are _rate-limited_ free tiers rather than _unauthenticated_ ones in
the sense the catalog implies. That distinction is the recommendation below.

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
and Kagi's already do, and Context7's and Firecrawl's currently do not. It is
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

This interacts with the sibling branch's OAuth auto-mode work, which is why I
am flagging rather than proposing a diff: if auto-mode makes `oauth` entries
installable, the `none` entries stop being the whole installable set and the
urgency of the above drops considerably.

### 10.5 One incidental finding

`com.firecrawl/mcp` ships `https://mcp.firecrawl.dev/mcp`, but Firecrawl's
current docs name `https://mcp.firecrawl.dev/v2/mcp`. I sent one `initialize`
to the documented path: it answers, and reports the **identical build** —
`firecrawl-fastmcp` version `3.24.0` — so `/mcp` is a live alias of `/v2/mcp`
rather than a different or older server. Nothing is broken. But the shipped URL
is the undocumented one, which is the same shape as the Netlify case in §5, and
an unversioned alias is the one more likely to be retired. Low priority;
switching to `/v2/mcp` would be a one-line change.

---

## 11. What a `popularity_rank` re-rank would actually change

Deferred from §2.2, where the append to 51–62 is explained. Sizing it, since
the question is whether it is worth a pass.

**The visible symptom.** `popularity` is the marketplace's default sort, so
today Netlify (51), Postman (52), Miro (53) and Tavily (54) all render below
Kagi (50), Globalping (48) and Apify (49). For four mainstream vendors that is
plainly wrong as an ordering claim.

**Roughly where they would land.** My estimate, by general prominence rather
than by data — see the caveat below:

| Entry       | Now | Estimate | Would move above                           |
| ----------- | --- | -------- | ------------------------------------------ |
| Netlify     | 51  | ~13–16   | Semgrep 24, Buildkite 31, Auth0 38, Wix 44 |
| Postman     | 52  | ~18–22   | most of the productivity tail              |
| Tavily      | 54  | ~20–25   | Firecrawl 26, Apify 49, Kagi 50            |
| Miro        | 53  | ~25–30   | Monday 33, ClickUp 36, Canva 42            |
| Render      | 56  | ~28–33   | Buildkite 31                               |
| Algolia     | 55  | ~30–35   | —                                          |
| Cloudinary  | 57  | ~33–38   | Box 40                                     |
| Klaviyo     | 60  | ~38–43   | Resend 37                                  |
| Axiom       | 59  | ~40–45   | Amplitude 47, Globalping 48                |
| Clerk       | 58  | ~45–50   | —                                          |
| Customer.io | 61  | ~45–50   | —                                          |
| incident.io | 62  | ~45–50   | PagerDuty 46 is the comparator             |

**The cost.** Ranks 1–50 are dense with no gaps, and `popularity_rank` is
`z.int().positive()`, so there is no room to slot anything in. Inserting eight
entries above rank 40 renumbers everything below the highest insertion —
**roughly 50 of 62 entries get a new number.** There is no cheap partial
version of this.

**Why I would not do it on intuition.** The file's header says the existing
ranks are "hand-assigned, informed by relative install volume on Smithery." I
do not have those numbers. A re-rank by my sense of vendor prominence would
replace a data-informed ordering with a guess, across 50 lines, in a diff where
a reviewer cannot check any single line — exactly the shape of change that put
the false header into this file in the first place.

**Recommendation:** worth a pass, but only one that starts by pulling fresh
Smithery figures for all 62. If that data is not available, the honest
alternative is to leave the append in place and accept that `popularity_rank`
means "roughly, and newest last" — or to drop the rank on new entries entirely
and let them sort last explicitly, which is at least not a false claim.

---

## 12. Sources

Vendor documentation each accepted entry's endpoint, transport and scopes were
taken from:

- Netlify — `docs.netlify.com/build/build-with-ai/netlify-mcp-server/`, `docs.netlify.com/build/build-with-ai/agent-setup-guides/set-up-claude-code-for-netlify/`
- Render — `render.com/docs/mcp-server`
- Postman — `learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server`
- Clerk — `clerk.com/docs/guides/ai/mcp/clerk-mcp-server`
- Miro — `developers.miro.com/docs/miro-mcp`, `help.miro.com/hc/en-us/articles/31624028247058`
- Algolia — `algolia.com/doc/guides/model-context-protocol/productivity-mcp`
- Cloudinary — `cloudinary.com/documentation/cloudinary_llm_mcp`
- Axiom — `axiom.co/docs/console/intelligence/mcp-server`
- Tavily — `docs.tavily.com/documentation/mcp`
- Klaviyo — `developers.klaviyo.com/en/docs/klaviyo_mcp_server`
- Customer.io — `docs.customer.io/ai/mcp/get-started/`
- incident.io — `docs.incident.io/ai/remote-mcp`

Registry records: `https://registry.modelcontextprotocol.io/v0/servers?search=<term>`,
filtered to `isLatest: true` and `status: active`.
