# Artifact runtime direction: Sandpack compatibility and portable npm apps

**Design proposal, not an approved migration or deprecation.** Investigated
2026-09-08 for [#2640](https://github.com/preset-io/agor/issues/2640).
Agor source revision: **`c3a2a1fd337cc285ab021961f831a5dc3d52370f`**.
The initial investigation changed no production code, customer apps, deployment
settings, or issue state. A subsequent user request authorized a narrow implementation:
HTML-as-JSON diagnostics and explicit compilation-completion reporting/waits.
The branch now includes those changes and tests, validated in its isolated
managed environment; the updated [Artifacts guide](../../apps/agor-docs/content/guide/artifacts.mdx)
describes the new status contract. The evidence below is the **pre-fix** snapshot.
Template changes, native hosting, migrations and deprecation remain proposals.

## Recommendation / decisions for Max

1. **Retain working Sandpack apps. Repair specific defects, not the entire
   population.** React, React-TS, React 18 CRA-layout apps, and several other
   templates rendered in this investigation. Blanket deprecation is not justified.
2. **Separate #2640 incident remediation from runtime strategy.** Its exact
   HTML-as-JSON crash was **not reproduced** in this environment. Obtain the
   failing browser's sanitized network evidence before prescribing a CDN,
   CSP, template, or source-code fix. The original deployment remains unresolved.
3. **Prefer a small, tested set of scaffolds, not embracing every upstream
   template.** Today: dependency-free `static` for HTML-first work, and pinned,
   explicit React/React-TS projects where browser bundling is appropriate.
   Keep existing defaults/records until a separately reviewed change; do not
   relabel an existing React app as static or silently update its dependencies.
4. **Long-term direction: ordinary npm projects plus build-once/static-preview
   publication**, with Sandpack as a compatibility/lightweight execution option.
   Native full-stack services are a separate, provider-backed product, not a
   prerequisite for replacing browser compilation. Do not make a native runtime
   the universal default until Cloud can actually build and serve it safely.

Max's short decision list:

- Approve a narrow diagnostics/template-certification follow-up, without removal?
- Is the first native deliverable **compiled frontend snapshots** (recommended),
  or paid/externally hosted full-stack services with ongoing lifecycle costs?
- Who owns the Cloud build/preview substrate, isolation review, quotas, and bill?
  Is bring-your-own remote hosting acceptable before first-party hosting exists?
- Should new-app guidance be capability-based, keeping Sandpack available when
  native publication is unavailable? Recommended: yes; never a dead-end default.
- Can we obtain the original browser capture and an authoritative vendor support
  statement? Neither a sample failure nor a forwarded cessation notice warrants
  deleting working applications.

## Evidence boundaries and revisions

### Original report and history

`gh issue view 2640 --repo preset-io/agor --json
title,body,comments,state,createdAt,updatedAt,url,author` returned an open issue by
rusackas, created/last updated **2026-08-31T18:36:03Z**, **zero comments**.
The paginated GitHub issue timeline returned no events. The report describes
two publishes of one React app, not tests of every React/React-TS artifact.
The dependency/CDN explanation and the family-wide impact are hypotheses, not
established fleet observations. The issue does not identify the deployed Agor
SHA, browser/version, effective `customSetup.environment`, or failed request.

The sole existing-app access was the authorized, read-only
`agor_artifacts_status` call for the issue's artifact
`01a02563-9be6-78ce-8afd-d383b6f2e3c4`: **not found**. This does not distinguish
absence from visibility/tenant filtering. No alternate-tenant lookup, database
query, customer file read, listing of unrelated apps, mutation, or migration was
attempted. Existing-app population and the original artifact's contents are
**untested**. A sanitized capture/read-only access was requested from the user.

The local checkout is shallow; history was read through GitHub's commits API,
not inferred from the shallow log. Relevant prior changes:

| Change | Exact merge revision                       | Relevance                                                   |
| ------ | ------------------------------------------ | ----------------------------------------------------------- |
| #914   | `47b470127bf7d087bde4338502bfdb1362cc65d7` | Earlier self-hosted bundler experiment                      |
| #918   | `dfc168b81069b04d839bdf95b1fb2c42d02a90c8` | Artifacts decoupled from worktrees; DB file maps            |
| #1147  | `be0dd98dda6e466a059a86ee6b390762f0006f3e` | Declarative format/consent; removed that local-bundler path |
| #1161  | `7f88e817e9ab3b7f287599e5aa3ff7a1810ae88d` | CRA `REACT_APP_` injection correction                       |
| #1432  | `3e738bd5c914323a87c1244885a1dfd104e783ec` | Browserless validation and browser-status diagnostics       |
| #2269  | `be6f0ab1a2b7d280f4d2d693906719446064f33a` | Narrow HTML-first vanilla → static repair                   |
| #2653  | `3f73029dc1239a4c9a866ae4dc4169a5b1d0bff9` | Artifact executor owner-home mounts, after the issue        |

These are readable as `https://github.com/preset-io/agor/commit/<revision>`.
The old [artifact-format design](../../docs/internal/artifacts-roadmap-2026-05-09.md)
records why local bundler support was removed. Its historical willingness to
break format compatibility is **not** authority to repeat that policy here.

### Upstream maintenance: verified facts versus inference

- [Sandpack releases](https://github.com/codesandbox/sandpack/releases/tag/v2.20.0):
  latest `v2.20.0`, published **2025-02-14T13:14:41Z**; main commit
  **`7d60a4334980eef304d53b1c3df371ed6dbcf491`**. GitHub API reports
  `archived:false`, `disabled:false`, last push 2025-04-24. That is substantial
  public release inactivity, not evidence every hosted runtime stopped working.
- Authoritative npm registry metadata: [React package](https://registry.npmjs.org/@codesandbox%2fsandpack-react)
  latest `2.20.0` (2025-02-14); [client](https://registry.npmjs.org/@codesandbox%2fsandpack-client)
  latest `2.19.8` (2024-09-12); [Nodebox](https://registry.npmjs.org/@codesandbox%2fnodebox)
  latest `0.1.9` (2023-11-29). These latest versions had no npm `deprecated`
  field. Agor's lockfile uses React package `2.20.0`, client `2.19.8`, Nodebox
  **`0.1.8`**, not `0.1.9`.
- A [maintainer's 2025-11-04 statement](https://github.com/codesandbox/sandpack/issues/1243#issuecomment-3484814859)
  reports a server repair and reduced attention, with occasional continued work.
  A March 2026 comment forwards an alleged vendor cessation email, but its author
  is not speaking for the vendor. No directly verifiable current vendor notice
  was obtained; the CodeSandbox docs/blog root requests returned 403 here.
  **Do not present that forwarded notice as independently verified official policy.**
- The [classic bundler's repository](https://github.com/codesandbox/codesandbox-client)
  is distinct from the Sandpack React wrapper. Its main revision was
  `dcba8ebc49cd46838e298cfa1501811ac67fb0c9`, 2026-09-07; the sandbox subtree's
  latest commit was `ddb9099a147e06728fe7ff5697b49c4eee489967`, 2025-11-12.
  Repository activity does not establish which revision the hosted bundle runs.
- The [experimental bundler](https://github.com/codesandbox/sandpack-bundler)
  is another project: main `a323f46fd38442bb2dbc76fecd262e1435aca5bd`,
  2024-08-14. Its [official compatibility page](https://sandpack.codesandbox.io/docs/advanced-usage/bundlers)
  lists React/Solid support and limitations for other templates. It is **not**
  a universal drop-in replacement, nor enabled by current Agor config.

Conclusion: **maintenance/support risk is high enough to diversify new-app
architecture; abandonment of all functional support is not proven.** Obtain a
direct vendor statement about security fixes, hosted endpoint lifetime and SLA.
React's separate [CRA sunset announcement](https://react.dev/blog/2025/02/14/sunsetting-create-react-app)
supports avoiding new conventional CRA projects. Sandpack's CRA-compatible
browser environment is not the same as executing a local CRA webpack server;
that announcement does not demonstrate its present runtime is broken.

## Current Agor contracts (source, not marketing promises)

Paths below refer to the Agor revision above. Guides now live under
`apps/agor-docs/content/guide/`, not the older `pages/guide/` path.

| Concern         | Current owner and behavior                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board apps      | `packages/core/src/types/board.ts`: inline `AppBoardObject` stores files/deps/template in board data. `AppNode.tsx` renders Sandpack directly. It is **not a native npm server** and does not run the artifact payload/consent pipeline.                                                                                                                                                                 |
| Artifacts       | `packages/core/src/types/artifact.ts`, schemas and artifact repository: board-owned DB file map + metadata; branch/path are provenance, nullable after branch deletion. Artifact lifetime is not dev-environment lifetime.                                                                                                                                                                               |
| Publish/land    | `services/artifacts.ts`, `packages/executor/src/commands/artifacts.ts`: caller/branch-scoped executor reads staging files; publishes into DB. `.git`, `node_modules`, symlinks, root `.env`, metadata sidecar are omitted by the reader. Files are UTF-8 strings, **not** a binary build-output store. `land` reconstructs source plus `agor.artifact.json`.                                             |
| Config          | `utils/sandpack-config.ts`: effective config template can override row template; `customSetup.environment` can override the bundler independently. No author-controlled `bundlerURL`, npm registry credentials, or external resource URL survives the options allowlist.                                                                                                                                 |
| Render          | `ArtifactNode.tsx` and `ArtifactFullscreenPage.tsx` use `SandpackProvider`/`SandpackPreview`; `sandpackDefaults.ts` stabilizes inputs, prepends body reset, defaults to user-visible initialization. `entryFile` becomes editor `activeFile`; it is not a replacement for `customSetup.entry`.                                                                                                           |
| Templates       | Sandpack merges implicit scaffold files with user files. A minimal stored map is not necessarily a runnable standalone npm checkout. `package.json` dependencies are canonical; config/cached dependencies participate in provider/export merging.                                                                                                                                                       |
| Env/consent     | `getPayload` derives viewing-user values after trust resolution and emits a transient `.env`; persisted source is not mutated. Self/covered trust requests inject values; untrusted consent-gated values are empty. Session-scoped env vars are not resolved without a matching session. A frontend env value is visible to the viewer/app and potentially exfiltratable, **not a backend-only secret**. |
| Runtime bridge  | `agor-runtime-source.ts` is inserted as a data-URL `externalResources` script. DOM requests traverse viewer browser → iframe, not daemon-side Chromium. Reports/logs are viewer-scoped and source/config revision checked.                                                                                                                                                                               |
| Status          | Folder validation never executes Sandpack. Browser error reporter sends `sandpack.error` and provider `sandpack.status`, not a network trace. In-memory waits/logs/DOM query correlation are process-affine; HA explicitly blocks synchronous introspection/status/waits, not durable artifact metadata.                                                                                                 |
| Security        | Tenant repository scopes/RLS + board/branch capabilities; public does not mean arbitrary cross-tenant access. `security-resolver.ts` allows `https://*.codesandbox.io` frames, blob workers; parent scripts do not require `unsafe-eval`. CORS to Agor and package CDN CORS are separate. Hosted iframe cookies must not become daemon authority.                                                        |
| Defaults/legacy | New publish falls back to `react`; docs already prefer `static` for new HTML-first apps. Narrow vanilla empty/comment-only conventional-entry repair remains. Old Handlebars sidecars have existing safe-degraded behavior: retain it, do not batch migrate.                                                                                                                                             |

Read together: [Artifacts guide](../../apps/agor-docs/content/guide/artifacts.mdx),
[environment guide](../../apps/agor-docs/content/guide/environment-configuration.mdx),
[HA support matrix](../../apps/agor-docs/content/guide/daemon-ha.mdx),
[security](../concepts/security.md), [tenancy](../concepts/multitenancy.md).
Some guide wording is stale: source need not still exist at a fixed branch path;
the DB map is durable truth. The guide's broad Nodebox possibilities do not add
Node/Vite/Next/Astro to the actual ten-member Agor template union.

## Reproduction and compatibility matrix

### Method and constraints

The [probe](artifact-runtime-probe/probe.cjs) and
[exact synthetic cases](artifact-runtime-probe/cases.json) are durable companions.
They run the actual published **SandpackProvider + SandpackPreview**, not a mocked
bundler. A small CommonJS loader wraps the npm distribution files without building
Agor. Playwright intercepts only a synthetic HTTPS parent page (and explicitly
named fault-injection requests). Real bundler/CDN requests use this machine's
network. No server process or managed environment was needed.

- Linux Google Chrome **146.0.7680.177**, headless, Playwright **1.58.2**;
  new browser context per case, no saved user profile or credentials.
  Chrome used `--no-sandbox` in this disposable test environment; this is **not**
  a production isolation/security validation or a recommended app-hosting setup.
- Host React/React DOM **19.2.8**; Sandpack React **2.20.0**, client **2.19.8**,
  Nodebox **0.1.8**, static-browser-server **1.0.3**. Agor's primary Sandpack
  lockfile versions match; this is not a full installation of its transitive UI tree.
- `initMode: immediate` deliberately removes viewport/lazy-mount variability;
  default observation 18 seconds; Nodebox 45 seconds. Real application text in
  the preview is the success criterion, **not** `status === running`.
- Current hosted classic URL: `https://2-19-8-sandpack.codesandbox.io/`;
  observed assets include `sandbox.8a7d01a44.js`,
  `sandbox-startup.a0ea8d1cb.js`, `babel-transpiler.dc3397b1.worker.js`.
  These are served asset identifiers, not a verified upstream source SHA.
- Successful React fetched JSON from `data.jsdelivr.com` and
  `prod-packager-packages.codesandbox.io`, with files from `cdn.jsdelivr.net`.
  React metadata failure also exercised an `unpkg.com` fallback.
  `ERR_ABORTED` on an initial frame navigation occurred even in passing cases;
  it is not, by itself, a failed build.
- Observed resolved application packages: React/React DOM **19.2.8** for the
  default pair, **18.3.1** for the issue's `^18.2.0` pair, Vue **3.5.42**, Svelte
  **3.59.2**, Angular core **11.2.14**, Solid **1.3.15** (override **1.9.15**).
  The Svelte compiler URL in the failing env probe was separately pinned to
  `https://unpkg.com/svelte@3.0.0/compiler.js` by the hosted runtime.
- Full Agor UI/API/consent flows, original deployment, private-network API calls,
  Firefox/Safari/mobile, long-lived tabs, offline operation, binary assets, and
  exports to live providers were **not tested**. Library-level success is not
  production-deployment or fleet-wide certification.

**W** = working for this synthetic case; **B** = broken for this case;
**U** = untested / unavailable, not broken. Env tests use only
`NON_SECRET_SENTINEL`; they test daemon-shaped payloads, not secret-store access.
All **25** companion cases were observed. Eight of the ten allowed template
names rendered their minimal app; Solid additionally rendered with the tested
override. This is a template probe count, not an existing-app census.

| Agor template | Actual pinned runtime / default entry              | Minimal rendering                                         | Current declared env path            | Env probe / interpretation                                                                      |
| ------------- | -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `static`      | static-browser-server; `/index.html`               | **W**, `STATIC_OK`                                        | none                                 | Not supported by Agor; no injection test                                                        |
| `react`       | `create-react-app`; `/index.js`, edits `/App.js`   | **W**, default React 19; **W** React 18 `/src` layout     | `REACT_APP_`, `process.env`          | **W**, `ENV_OK`; also **W** with actual Agor runtime script + body reset                        |
| `react-ts`    | `create-react-app`; `/index.tsx`, edits `/App.tsx` | **W**, default React 19                                   | `REACT_APP_`, `process.env`          | **W**, `ENV_OK`                                                                                 |
| `vanilla`     | `parcel`; `/index.js`                              | **W**                                                     | none                                 | Not supported by Agor; do not conflate with Parcel features generally                           |
| `vanilla-ts`  | `parcel`; `/index.ts`                              | **W**                                                     | none                                 | Not supported by Agor                                                                           |
| `vue`         | `vue-cli`, Vue 3 scaffold; `/src/main.js`          | **W**                                                     | unprefixed `process.env.PROBE`       | **B** for intended value: renders `ENV_MISSING`                                                 |
| `vue3`        | no matching Sandpack 2.20.0 template               | **B**, invalid-template exception before iframe mount     | inherited `VITE_`                    | **U**, runtime cannot initialize; a row overridden to valid `vue` is a different effective case |
| `svelte`      | `svelte`, Svelte 3 scaffold; `/index.js`           | **W**                                                     | inherited `VITE_`, `import.meta.env` | **B**, parser rejects `import.meta` in fixture; not HTML-as-JSON                                |
| `solid`       | `solid`; `/index.tsx`; default `solid-js:1.3.15`   | **B** default; **W** with only `solid-js:1.9.15` override | inherited `VITE_`, `import.meta.env` | **B** on aligned runtime: `Cannot use 'import.meta' outside a module`                           |
| `angular`     | `angular-cli`, Angular 11 scaffold; `/src/main.ts` | **W**                                                     | unprefixed `process.env.PROBE`       | **B** for intended value: renders `ENV_MISSING`                                                 |

The Solid failure is `_tmpl$ is not a function` in `/App.tsx`. The network trace
shows `solid-js/1.3.15` with `babel-preset-solid/1.9.15`; changing the synthetic
runtime package to `1.9.15` renders `Hello world`. This strongly suggests a
template/compiler version mismatch, **not proof all existing Solid apps fail**.
Do not apply that dependency upgrade to customer source without testing/consent.

Additional coverage:

| Case                            | Result and meaning                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue-shaped React 18           | `package.json` with `react`/`react-dom:^18.2.0`, `public/index.html`, `src/index.js`, `src/App.js`: **W** (`CRA18_OK`) both with explicit `/src/index.js` entry/main and without either. Original secret/API/application logic deliberately absent.                                                                 |
| React + Agor payload additions  | **W** (`AGOR_ENV_OK`) with non-secret `.env`, body reset and exact `AGOR_RUNTIME_SOURCE` data URL. Does not certify the daemon consent/bridge round-trip.                                                                                                                                                           |
| Relevant parent CSP allowlist   | **W** with `frame-src 'self' https://*.codesandbox.io`, self scripts, blob workers; **B**, explicit frame-block message with `frame-src 'self'`. These are controlled headers, not the affected deployment's headers.                                                                                               |
| React metadata returns HTML     | One jsDelivr endpoint replaced with HTTP 200 HTML: **W**, fallback to unpkg. Replacing both React metadata paths: **B**, React 19.0.0 vs React DOM 19.2.8 version mismatch after fallback, **not the original error**. This cautions against diagnosing a specific dependency endpoint from the overlay text alone. |
| Upstream `vite-react` / Nodebox | **W**, `Hello world`, runtime `node`, real `*.nodebox.codesandbox.io` preview. **Not an exposed Agor template**; no env/Cloud endorsement. Other Nodebox templates (Node, Next, Astro, other Vite variants) **U**.                                                                                                  |
| Original artifact/deployment    | **U**; inaccessible from authorized context. Its exact crash is not reproduced or resolved.                                                                                                                                                                                                                         |

### Distinguishing causes and immediate remediation

The report's ErrorBoundary and guarded fetch narrow the possibilities, but do
not prove no application code ran: boundaries do not catch import-time errors,
all async failures, or failures outside their subtree. `Unexpected token '<'`
means an HTML-like body reached a JSON parser; it does not identify that parser
or the response producer. An upstream user reported a similar symptom for
`/_sandpack_/manifest.json` in [July 2025](https://github.com/codesandbox/sandpack/issues/920#issuecomment-3086769114),
but that is a **different incident**, not proof of #2640's cause.

For the authorized failing browser, capture the **first causal failed request**:
hostname/path (strip query credentials), initiator/frame, status, content type,
redirect chain, CORS/CSP messages, and a manually redacted body classification
(HTML login/challenge/error page versus JSON). Record timestamp, browser,
effective template/environment, app revision, Agor SHA and deployment mode.
Do not collect full source, `.env`, cookies, authorization headers, or raw HARs
in shared logs. Browser extensions, corporate proxy, VPN, DNS, and service-worker
state should be varied one at a time in a disposable browser context.

| Observation                                       | Owner / next action                                                                                                                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact payload URL returns HTML                 | Agor ingress/auth/routing defect or deployment proxy; inspect before blaming npm.                                                                                                                                    |
| Parent blocks iframe/worker                       | Compare actual effective CSP to resolver defaults. Correct the precise deployment directive; do not disable CSP or add blanket `unsafe-eval`/wildcard CORS.                                                          |
| Public package/manifest URL returns HTML          | CDN/edge/proxy/redirect/service failure. Compare same synthetic case on another browser/network, retain sanitized request evidence, escalate upstream. Daemon `curl` success alone says nothing about viewer egress. |
| No browser report / HA unsupported                | Observation unavailable, not broken application. Open correct viewer's frame if standalone; respect HA gate.                                                                                                         |
| `vue3` invalid, Solid mismatch, env idiom failure | Specific Agor integration/template mismatch; test a render adapter/scaffold repair separately. Preserve persisted source and working effective overrides.                                                            |
| API fetch fails only after app appears            | App API auth/CORS/mixed-content/Chrome local-network access. Different from compiler/dependency boot. Review browser network rules, not unrelated repo clone connectivity.                                           |

Two concrete Agor diagnostics defects warrant a separately approved small patch:

1. `buildStatusDiagnostic()` currently classifies `/JSON|Unexpected token/` as
   `malformed_package_json_or_syntax`. Add an HTML-as-JSON/network-response branch
   first, without pretending to know which endpoint failed; retain true syntax
   diagnostics and recommend a redacted browser trace.
2. Successful probes expose provider `sandpack.status: running` while bundler
   messages say `status:idle` / `done` and the app is visible. The reporter sends
   the former; `waitForRuntimeStatus()` accepts non-`running` as success and can
   time out claiming no report despite an observed running app. Conversely,
   `idle` alone can mean not yet started. This is a source-traced state-contract
   mismatch, not an end-to-end daemon test. Distinguish provider lifecycle,
   compilation completion, observed render, error and unavailable observation;
   validate with actual library events and content/viewer revision fencing.

Immediate issue follow-up should improve diagnosis and test these contracts;
do not "fix" #2640 by dropping React, synthesizing secrets into static HTML,
switching every bundler, or changing a customer's dependencies. A refresh/new
context is a diagnostic comparison, not a demonstrated durable fix.

## Options and what “native” means here

Sandpack already consumes npm dependencies. The decision is **where installation,
compilation and serving happen**, not “templates versus npm.” A Sandpack
`vite-react` Nodebox instance is still an in-browser runtime, not native hosting.

| Option                                                                                     | Benefits                                                                                            | Costs/constraints                                                                                                    | Recommendation                                                                             |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Retain and repair selected Sandpack templates                                              | Immediate board preview; no per-app server; preserves DB-backed apps                                | Hosted boot/dependency services, aging compilers, browser limits, viewer-time network failures                       | Yes, compatibility plus tested lightweight path                                            |
| Self-host classic bundler and dependency service                                           | Operator controls availability/egress; potential warm offline use                                   | Own complex toolchain, CDN/mirror, updates, isolation, capacity and security response; previous Agor attempt removed | Consider only for a measured hosted-service failure/SLA requirement; not first remediation |
| Switch to experimental bundler / Nodebox broadly                                           | Different compiler/runtime capabilities                                                             | Different compatibility, shared upstream support risk; Nodebox is still browser-constrained                          | Do not blanket switch; isolated opt-in evaluation only                                     |
| New-app scaffolds are ordinary npm projects, still previewed with Sandpack when compatible | Better export, explicit entries/deps, no new server requirement                                     | Scaffold must also satisfy Sandpack; lockfile is not proof browser resolver obeys npm semantics                      | Useful incremental step                                                                    |
| Native build → immutable static bundle → isolated preview                                  | Standard tools/lockfiles; build once per revision, cheap repeated views; no live app process needed | New build admission, binary assets, output storage, preview origin/auth and runtime config bridge                    | Preferred first native architecture                                                        |
| Native persistent Node/backend service                                                     | Real Node, sockets, databases, backend-only secrets                                                 | Process/container/microVM runtime, ingress/WebSockets, state, quotas, idle shutdown, HA, billing/on-call             | Separate opt-in provider-backed capability, not default Cloud promise                      |

[Upstream self-hosting instructions](https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)
require the classic codesandbox-client build, separate serving and potentially a
registry proxy. Hosting the iframe bundle alone does not remove package/CDN
dependencies. Keep it on an untrusted origin, not Agor's authenticated UI origin.

### Native contract proposal (not present implementation)

“Native npm app” should mean a versioned source snapshot with ordinary
`package.json`, package-manager lockfile, explicit entry and standard scripts,
built by **real Node/npm on an admitted worker or external provider**. It is not
executed in the daemon request handler or assumed to be a long-lived executor task.

- **Build/install:** pin Node, package manager, registry policy and worker image;
  verify lockfile/integrities. Use `npm ci`/equivalent frozen install, initially
  lifecycle scripts disabled. Explicitly allow required install scripts only
  inside the same untrusted-code isolation; disabling scripts is not a sandbox
  and build/plugin code still executes. No inherited daemon environment, provider
  login home, Docker socket, cloud metadata access or unrelated branch mounts.
- **Storage:** source belongs to tenant + artifact/board, not just a disposable
  branch directory. Keep immutable revisions and source digest. Store binary
  build outputs in tenant-bound object storage, with output digest and manifest;
  do not treat today's UTF-8 file map as an arbitrary `dist` upload mechanism.
  Cache keys include ownership/registry policy, lockfile digest, image/toolchain
  and architecture. Share only verified public immutable packages globally;
  private packages, outputs and credentials remain tenant-scoped.
- **Startup/serving:** static snapshots have no per-app startup. An authenticated
  preview gateway serves immutable assets on a separate untrusted origin.
  React routing/base paths, content types, CSP and frame permissions must be
  tested. Do not serve arbitrary uploaded HTML on Agor's cookie-bearing origin.
  [Vite documents](https://vite.dev/guide/static-deploy) deployment of build output;
  `vite preview` is a local preview tool, not the production server.
- **Development loop:** agents edit the branch staging project; a publish creates
  a new admitted build and atomically replaces the preview only on success.
  This trades Sandpack's immediate browser recompilation for build latency.
  Optional `npm run dev`/HMR belongs in an operator-managed branch environment
  or remote workspace with explicit app URL and WebSocket ingress, not a daemon
  child or Cloud executor background process. Development source/workspace
  lifetime and the published snapshot's lifetime must remain separate.
- **Secrets:** public compile-time configuration is distinct from backend
  credentials. Never bake viewing-user secrets into shared bundles/cache keys
  or a shared server process. Preserve existing Sandpack consent behavior.
  For new native apps, prefer a reviewed, narrow server-side capability broker
  with caller/tenant/board/resource authorization on every use; no generic
  secret-bearing arbitrary-URL proxy. If legacy-compatible viewer-side injection
  is added, it needs explicit consent, private/no-store delivery, revision-bound
  messages and tests; it still does not make secrets private from app JavaScript.
  App-owned backend credentials and per-viewer credentials are different scopes.
- **Preview bridge:** preserve board/fullscreen affordances and identity without
  coupling them to Sandpack hooks. Validate message source, origin, schema,
  viewer, request nonce and revision; bound DOM/log payloads. Do not broaden
  legacy wildcard communication into universal daemon access. Live external URLs
  must be independently authorized and tested for embedding; no cookie/token
  appended to arbitrary provider URLs.
- **Isolation/resources:** real npm executes untrusted package/build code.
  Require a reviewed sandbox/container/microVM or external equivalent, fail
  closed when unavailable, restricted egress and filesystem, hard memory/CPU/PID,
  disk/output/log/time limits, cancellation and cleanup. Initial _pilot proposal_,
  not current capacity: 2 vCPU, 2 GiB, 180 s per build, 25 MiB output and 1 MiB
  logs; one active build/user, two/tenant plus a global admission cap. Measure
  and revise limits; oversized apps should get a clear external-provider path.
  Browser Sandpack CPU/memory remains browser-controlled, not covered by these
  quotas. A task timeout alone is not containment or a resource quota.
- **Tenant/HA:** new source, builds, revisions, preview tokens, private caches,
  runtime logs, service instances and cleanup are tenant-owned or derived.
  Carry trusted tenant identity through admission → worker → callback → storage
  → ingress; IDs and authorization do not substitute for tenant scoping.
  Persist job attempts with idempotency, leases/generation fencing and
  compare-and-swap publication of the output pointer. Late/replayed callbacks
  cannot publish a superseded or another tenant's build. Stateless asset delivery
  must work on any replica. Keep secret-derived viewer telemetry isolated;
  do not assume existing process-local Sandpack waits became HA-safe.
- **Lifecycle:** last-known-good output remains available after a failed build
  and after branch deletion, matching artifact durability. Deletion/revocation
  must fence pending builds and preview capabilities, then clean outputs, private
  caches, remote jobs and any service volumes. Tenant erasure/export/restore must
  include these resources, not just database rows.
- **Persistent-service extension:** provider owns process start/health/restart,
  signed admission, stable authenticated ingress/WebSockets, writable volumes,
  service secrets and a reconciler. Specify idle suspension, max lifetime,
  reconnect behavior, server-side request limits, crash cleanup, per-tenant
  budget and billing before enabling. No exposure of executor Pod ports.

### Cloud feasibility is a gate, not an assumption

The current [environment contract](../../apps/agor-docs/content/guide/environment-configuration.mdx)
explicitly says executor Pod servers are **not exposed**, commands are bounded,
and managed environments can launch a **remote** provider. HA external/delegated
hybrid mode is an admitted lifecycle-command protocol (10 s launcher admission,
60 s claim, command at most 300 s, bounded overall job), not app ingress/hosting.
Webhook-only mode accepts public HTTP(S) GET lifecycle endpoints, no custom
headers/body/signing, no redirects or URL credentials. That alone is not a
secure arbitrary native-runtime control plane. Do not place secrets in queries.

| Deployment                    | Sandpack                                                                          | Native npm build/static publication                                                                                                 | Long-lived native services                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Standalone trusted local      | Present, browser/network-dependent                                                | Possible with separately admitted local worker/asset server; new integration required                                               | Operator-managed environment possible; not safe merely because `simple` can run a shell     |
| Standalone sandbox/delegated  | Present                                                                           | Requires matching isolated worker/provider and storage/preview contract                                                             | Provider/OS isolation + explicit ingress and lifecycle required                             |
| HA external / Agor Cloud      | Browser rendering/durable metadata present; synchronous runtime observation gated | Plausible future bounded build service + durable object store + preview gateway; **not currently supplied by managed environments** | External hosting only where provisioned; do not launch a background server in executor Pods |
| Restricted/offline deployment | Existing cold-start hosted dependencies may fail                                  | Prebuilt, internally served assets reduce runtime external dependence, but new installs/builds still need mirrored packages         | Requires an operator-provided offline runtime, not a universal fallback                     |

A capability response should distinguish browser rendering, static publication,
external preview, native build and native service support. Offer only available
new-app routes. Preserve legacy records when a capability is unavailable rather
than silently converting them. Model runtimes separately from template names;
an absent discriminator must continue to mean legacy Sandpack. Extend canonical
core types, not duplicate frontend/MCP unions in the eventual implementation.

## Portability, dependency security and operational cost

**Export/migration is opt-in and reversible.** `land` recovers stored source and
metadata; it does not necessarily materialize Sandpack's implicit scaffold.
The UI export captures resolved provider files/environment and strips `.env`;
the daemon CodeSandbox exporter reconstructs from stored files/dependencies and
uses the define API. Those are not identical exports. Test both before promising
round-trip fidelity; no live CodeSandbox export was performed here.

A future portable export must include explicit entry/HTML, scripts, deps,
lockfile and toolchain, source assets, licenses and a non-secret config manifest;
exclude injected `.env`, tokens and generated Agor runtime resources. Resolve
template-added files and dependencies intentionally. Convert CRA entry/JSX/TS,
asset paths and env reads to Vite only in a **new copy**. Database/network drivers,
Nodebox polyfills, source-path imports and private registries need a compatibility
review. Rendering equal HTML once is insufficient: compare interactions,
styles/assets, errors, configuration, API permissions and recovery. Keep the old
artifact/runtime selectable until its owner accepts the new revision; test rollback.

Offline: neither `static` nor Nodebox in today's Agor means a cold offline app.
Static uses a hosted preview/relay; classic uses hosted scripts/workers/package
resolution; Nodebox uses hosted runtime/preview/package services. Warm browser
caches can help but are not a durable offline contract. Native **built** assets
can avoid those services at view time; offline installation requires a complete
verified registry/cache, and app APIs may still need network access.

Dependency risk exists in both approaches. Pin new scaffold dependencies and
record resolved runtime packages; floating ranges and hidden compiler packages
can drift (the Solid probe is an example). Retaining a lockfile in Sandpack
source does not establish npm lockfile enforcement by its resolver. Native npm
improves reproducibility through [frozen installs](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
but introduces package lifecycle/build code on workers, native addons and image
patching. Require provenance/integrity checks, vulnerability/license review,
registry allowlists, bounded network access and ongoing rebuild policy. Do not
auto-upgrade every existing app as a security “fix”; evaluate exposure and retain
an explicit rollback. No vulnerability scan or full dependency security audit
was performed in this investigation.

Cost comparison: Sandpack shifts compilation/memory to each viewer and relies on
vendor services; native static builds spend worker time once per source revision
then storage/CDN bandwidth per view; native services add ongoing compute,
volumes, ingress and on-call burden even when code is unchanged. Self-hosting
Sandpack adds another compiler/CDN service to operate. Measure p50/p95 cold/warm
first render, build success, worker seconds, image/install/cache size, artifact
egress, idle-service hours, support incidents and per-tenant noisy-neighbor
behavior before budgeting. No dollar pricing or production capacity estimate
is established by these small browser probes.

## Staged plan and exit criteria

1. **Incident evidence + diagnostics (first follow-up PR):** reproduce in the
   authorized reporting browser, correct HTML/JSON guidance and readiness
   semantics, add negative tests for syntax errors, blocked iframe, HTML response,
   stale revision, no viewer and HA unsupported. Do not expand logging of secrets.
   Exit: known owner/cause or honestly classified unresolved deployment failure;
   successful apps are not reported as failed merely because they are `running`.
2. **Compatibility certification (independent PRs):** ten-template browser smoke
   suite and env sentinels, board/fullscreen parity, actual Agor payload flow;
   test `vue3` render alias/config validation and Solid scaffold alignment in
   copies. Broaden docs only to demonstrated env conventions. Repair only the
   proven shape; retain working source/config overrides. Test Chrome, Firefox,
   Safari; HTTPS and supported local/private deployments; cold/warm/aged tabs.
3. **New-app guidance/scaffold registry:** versioned explicit scaffolds with
   declared runtime/entry/env/offline/export capabilities. Static HTML-first and
   tested React paths remain usable now. Native instructions route to an
   approved remote provider only where available. Changing a default must not
   reinterpret persisted rows or inline board apps.
4. **Native static pilot:** synthetic apps only, reviewed build admission,
   isolated output origin/store, authenticated preview and normal npm export.
   Prove cross-tenant read/write/token/cache/replay denial; cross-viewer secret
   denial; branch deletion, tenant deletion, revocation, crash/cancel cleanup;
   two replicas handling different job stages without stale publication.
   Load-test quotas and measure cost. Cloud team signs off on substrate and
   ingress, not just a local demo. Production rollout requires separate approval.
5. **Optional owner-driven copy migration:** compare app behavior/config/export,
   preserve original, show capability/cost differences, require acceptance and
   retain rollback. No automated fleet migration in this proposal.

### Evidence required before even recommending deprecation of existing support

- Complete, **authorized metadata-only** inventory covering artifact rows **and
  inline board apps**, effective template/config/environment overrides, legacy
  shapes and deployment/browser classes. Use trusted tenant-scoped reads;
  publish only approved aggregates. Inaccessible/unobserved apps remain unknown.
- Strong, repeated evidence that **all affected apps/templates are effectively
  broken** within the precisely proposed scope, not one scaffold or time window.
  Account for working pinned/custom configurations. A working counterexample
  prevents a family-wide claim; this investigation has several.
- Exclude repairable integration, endpoint/network/CSP and version-specific
  causes; get upstream endpoint/support clarity. A vendor EOL notice is risk
  evidence but does not prove every app is broken.
- Demonstrate a replacement in every supported affected deployment, especially
  Cloud, with tenancy, secrets, export fidelity, costs and rollback proven.
  Obtain explicit product/owner approval, notice and a preservation/access plan.

Until those gates are met: **preserve support and working apps; unknown stays
unknown.** No closure, merge, deployment, removal or deprecation is authorized
by this investigation.

## Running the synthetic reproduction again

Use a disposable directory. The script writes result JSON beside itself; do not
run it with customer file maps or real env values. It launches a bounded headless
browser, not an app server, and has no Agor or GitHub mutation calls.

```bash
repo="$PWD"
probe="$(mktemp -d /tmp/agor-2640-probe.XXXXXX)"
cp context/explorations/artifact-runtime-probe/probe.cjs "$probe/probe.cjs"
npm install --prefix "$probe" --ignore-scripts --no-audit --no-fund \
  playwright@1.58.2 @codesandbox/sandpack-react@2.20.0 \
  react@19.2.8 react-dom@19.2.8
node "$probe/probe.cjs" \
  "$repo/context/explorations/artifact-runtime-probe/cases.json" \
  > "$probe/probe.log" 2>&1
```

Requires `/usr/bin/google-chrome` (adjust the explicit path on other machines).
Baseline fixtures use upstream scaffolds from the exact Sandpack package; the
case file includes issue-shaped overrides, sentinel env probes, fault injections
and the Agor runtime source snapshot. Names identify JSON result files. Network
and HTML excerpts are safe only because these fixtures are synthetic.
Initial investigation outputs are at `/tmp/agor-2640-investigation/` (ephemeral,
not a production evidence store); durable observations are summarized above.
Hosted assets and floating application dependency ranges can change despite a
pinned client, so a rerun is a new observation, not guaranteed byte-for-byte replay.
