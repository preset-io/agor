# Lightweight Knowledge Base entrypoint proposal

_Date: 2026-06-04_

_Branch: `kb-lightweight-entrypoint-analysis`_

## Summary recommendation

Treat Knowledge Base (KB) as a route island with its own lightweight boot path. A fresh external deep link to `/kb/...` or `/knowledge/...` should load only:

1. global UI scaffolding (router, theme, Ant app, error boundary),
2. auth/session basics (`/health`, token restore/refresh, current user), and
3. KB-specific data (`kb/namespaces`, `kb/documents` or `kb/search`, `kb/versions`, `kb/graph`, plus a small user/mention dependency if needed).

It should **not** hydrate the workspace store or open an authenticated Socket.IO workspace connection until the user navigates back into the main app. If the user reaches KB from an already-loaded board/session view, keep the existing workspace state alive and do not tear down the socket/store just because the route changed.

The safest implementation shape is a route-aware shell with two optional runtimes:

- **KB runtime:** REST-first client, no broad live subscriptions, KB page bundle only.
- **Workspace runtime:** existing socket client, `useAgorData`, board/session providers, app actions, broad service listeners.

## Current boot and loading flow

### Entry and top-level providers

Current UI entry is `apps/agor-ui/src/main.tsx`:

- installs the clipboard polyfill globally;
- renders `<App />` into `#root`;
- keeps `window.__agorClient` for HMR socket cleanup.

`apps/agor-ui/src/App.tsx` then mounts, unconditionally for every route:

```tsx
<BrowserRouter basename={basename}>
  <ThemeProvider>
    <ConfigProvider>
      <AntApp>
        <ErrorBoundary variant="global">
          <CanvasNavigationProvider>
            <AppContent />
          </CanvasNavigationProvider>
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  </ThemeProvider>
</BrowserRouter>
```

These global providers are reasonable for KB. The issue starts inside `AppContent`, before route selection.

### AppContent boot sequence

`AppContent` calls these hooks before rendering `<Routes>`:

1. `useAuthConfig()`
   - Fetches `${daemonUrl}/health`.
   - Provides auth, instance, onboarding, services, and feature config.
2. `useAuth()`
   - Creates a REST client with `createRestClient()`.
   - Restores tokens or refreshes tokens.
   - Sets `user`, `authenticated`, and `accessToken`.
3. `useAgorClient({ accessToken })`
   - Creates the socket-backed Feathers client with `createClient(url, false)`.
   - Opens Socket.IO and authenticates with JWT.
   - Stores the client on `window.__agorClient`.
4. `useServerVersion(client)`
   - Fetches `/health` again on mount.
   - Polls `/health` every 60s.
   - Adds a `server-info` socket listener when a socket client exists.
5. `useAgorData(client, { enabled: !user?.must_change_password })`
   - Performs the workspace initial fetch.
   - Registers broad Feathers service listeners.
   - Refetches all workspace maps on socket reconnect.
6. `useSessionActions()` and `useBoardActions()`
   - Create action wrappers for main app workflows.

Only after the above does `AppContent` evaluate route elements. So a fresh `/kb/...` deep link pays the same auth, socket, and workspace-store cost as `/b/...`.

### Workspace initial fetch that runs for KB deep links

`apps/agor-ui/src/hooks/useAgorData.ts` is the main source of board/branch/user/etc. loading. On initial mount it runs a `Promise.all` over these services:

- `sessions.findAll({ archived: false, $limit, $sort })`
- `boards.findAll({ $limit })`
- `board-objects.findAll({ $limit })`
- `board-comments.findAll({ $limit })`
- `cards.findAll({ $limit })`
- `card-types.findAll({ $limit })`
- `repos.findAll({ $limit })`
- `branches.findAll({ archived: false, $limit })`
- `users.findAll({ $limit })`
- `mcp-servers.findAll({ $limit })`
- `session-mcp-servers.findAll({ $limit })`
- `gateway-channels.findAll({ $limit })`
- `artifacts.findAll({ $limit })`
- `mcp-servers/oauth-status.find()`

The loading screen is also tied to this full workspace load via `useInitialLoaderPhase()`. KB routes therefore cannot render until these non-KB items finish.

### Workspace live subscriptions that are installed for KB deep links

The same hook registers service listeners for:

- `sessions`
- `boards`
- `board-objects`
- `repos`
- `branches`
- `users`
- `mcp-servers`
- `gateway-channels`
- `cards`
- `card-types`
- `artifacts` including `agor-query`
- `session-mcp-servers`
- `board-comments`
- socket events `oauth:completed`, `oauth:disconnected`, and `connect`

Even if KB does not read these maps, they update React state in the background.

There is a second server-side consideration: `apps/agor-daemon/src/register-hooks.ts` has a global `app.publish()` that broadcasts service events to the `authenticated` channel. `apps/agor-daemon/src/setup/socketio.ts` joins every authenticated browser socket to that channel after login. Today there is no route- or service-scoped browser subscription. Therefore, a KB page that opens an authenticated socket can still receive broad service-event traffic over the network even if no React listener is attached for a given service.

### Route and bundle shape

`App.tsx` statically imports all major route components:

- `./components/App` as `AgorApp` (main workspace shell),
- `./components/mobile/MobileApp`,
- `./pages/KnowledgePage`,
- `./pages/StreamdownDemoPage`,
- onboarding/settings/session action dependencies.

The router includes KB routes:

```tsx
<Route path="/knowledge" element={<KnowledgePage ... />} />
<Route path="/knowledge/:namespaceSlug/*" element={<KnowledgePage ... />} />
<Route path="/kb" element={<KnowledgePage ... />} />
<Route path="/kb/:namespaceSlug/*" element={<KnowledgePage ... />} />
```

Because these imports are static and the workspace store is started above the router, a KB external deep link does not currently benefit from route-level code splitting or runtime isolation.

## Current KnowledgePage dependencies

`apps/agor-ui/src/pages/KnowledgePage.tsx` is a self-contained 2,260-line page. It does **not** consume `AppDataContext`; it receives only:

```ts
interface KnowledgePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  userById?: Map<string, User>;
}
```

Important KB-specific API calls:

- `kb/namespaces.find({ archived: false })`
- `kb/documents.find({ archived: false })` for mention docs across namespaces
- `kb/documents.find({ namespace_slug, kind, archived: false })`
- `kb/search.find({ q, namespace_slug, kind, limit })`
- `kb/graph.find({ namespace })`
- `kb/versions.find({ document_id, include_content: true })`
- `kb/documents.create/patch/remove` for editing

The only clear non-KB data dependency is `userById`, used for `@` user mentions in the editor. On the current page this comes from the full `users` map loaded by `useAgorData`. For a lightweight KB runtime this should become one of:

1. a KB-local, lazily loaded `users.find` only when the editor/mention UI opens;
2. a small `users/mentionable` service returning just IDs/display names/emails; or
3. accept degraded user mentions on the first lightweight PR and add the smaller endpoint later.

KB already handles in-app links internally: `KnowledgePage` intercepts same-origin `/kb` and `/knowledge` markdown links and uses React Router `navigate()` instead of opening a new tab. Its back button currently does `navigate('/')`, which is the right trigger to hydrate the workspace if the workspace has not been started yet.

## Desired behavior by navigation source

### 1. External KB deep link / fresh page load

Example: user clicks a Slack link to `/ui/kb/global/pages/onboarding.md`.

Desired sequence:

1. Load minimal JS for global shell + KB route.
2. Fetch `/health` once for auth/config/version baseline if possible.
3. Restore/refresh auth with REST.
4. Create a KB API client that does not join the broad authenticated socket channel.
5. Render KB as soon as KB data is available.
6. Do **not** load `sessions`, `boards`, `branches`, `repos`, etc.
7. Do **not** subscribe to broad workspace realtime events.
8. If user clicks back/home to `/` or another workspace route, start workspace runtime then show the existing initial loading screen for workspace hydration.

A fresh KB page can be a different app in practice. It can have its own header and not mount `AgorApp`, `OnboardingWizard`, workspace actions, event stream, task chimes, favicon session status, or board/session providers.

### 2. Internal navigation from an already-loaded main app

Example: user is on a board, clicks the header Knowledge button, or clicks a KB link from an artifact/session message.

Desired sequence:

1. Keep the already-hydrated workspace store alive.
2. Keep the socket alive if the workspace shell is already using it.
3. Render KB either inside the same authenticated shell or as an overlay/sibling route.
4. Do not clear board/session state.
5. Returning from KB to `/`, `/b/...`, `/s/...`, etc. should be instant because state was preserved.

This is the main nuance: route changes alone should not always start or stop workspace runtime. The decision should be based on whether the workspace runtime has already been initialized in this tab.

## Design options

### Option A — Minimal route gate inside current AppContent

Add route awareness to `AppContent` and gate `useAgorData`:

```ts
const location = useLocation();
const isKnowledgeRoute = /^\/(kb|knowledge)(\/|$)/.test(location.pathname);
const [workspaceEverStarted, setWorkspaceEverStarted] = useState(false);
const workspaceShouldRun =
  !user?.must_change_password && (!isKnowledgeRoute || workspaceEverStarted);
```

Then:

- call `useAgorData(client, { enabled: workspaceShouldRun })`;
- mark `workspaceEverStarted` after initial workspace load completes or when route becomes non-KB;
- bypass the workspace initial loading screen for KB routes when the workspace has not started;
- pass `user` as `currentUser` to KB even if `userById` is empty.

**Pros**

- Smallest code change.
- Preserves workspace state on internal navigation if `workspaceEverStarted` is true.
- Avoids the 14-service `useAgorData` initial fetch for fresh KB links.

**Cons**

- Still creates and authenticates a Socket.IO client for fresh KB links.
- Because authenticated sockets are in the global `authenticated` channel, broad service-event traffic may still be delivered over the wire.
- `App.tsx` remains a large mixed shell with many action handlers initialized for KB.
- Needs care around `useInitialLoaderPhase`, because it currently waits for `initialLoadComplete`.

**Use as:** safe first PR if we want quick network-load relief before deeper runtime split.

### Option B — Split `AppContent` into route islands, keep one React app

Refactor into:

```tsx
<AppProviders>
  <Routes>
    <Route path="/kb/*" element={<KnowledgeEntry />} />
    <Route path="/knowledge/*" element={<KnowledgeEntry />} />
    <Route path="/*" element={<WorkspaceEntry />} />
  </Routes>
</AppProviders>
```

Where:

- `AppProviders` owns theme, router, error boundary, auth config, and auth state.
- `KnowledgeEntry` owns KB data and renders `KnowledgePage`.
- `WorkspaceEntry` owns `useAgorClient`, `useAgorData`, workspace action handlers, onboarding, and desktop/mobile routes.
- A small `WorkspaceRuntimeProvider` can stay mounted once started, so internal navigation to KB preserves state.

A practical implementation detail is to track runtime state in a provider above routes:

```ts
type WorkspaceRuntimeMode = 'not-started' | 'starting' | 'running';
```

- On a fresh KB route, mode remains `not-started`.
- On first non-KB route, mode becomes `starting/running` and mounts workspace runtime.
- On internal navigation from workspace to KB, keep mode `running` and keep the runtime mounted, even if the visible route is KB.

**Pros**

- Clear product model: KB is a sub-app while still sharing auth/theme.
- Preserves workspace state for internal navigation.
- Makes workspace boot dependencies explicit and testable.
- Enables code splitting (`React.lazy`) for KB and workspace shells.

**Cons**

- Medium refactor: `AppContent` currently contains routing, auth gates, workspace actions, onboarding, and all route elements in one component.
- Requires careful extraction to avoid changing behavior of login, force-password-change, onboarding, GitHub setup callback, mobile redirects, and connection banners.

**Use as:** recommended target architecture.

### Option C — KB uses a REST-only client until workspace starts

Introduce a lightweight client hook for KB:

```ts
function useAgorRestClient(accessToken: string | null) {
  // createRestClient(getDaemonUrl()), authenticate with JWT, install same refresh retry hook if needed
}
```

`KnowledgeEntry` uses this REST client when `workspaceRuntime.mode !== 'running'`. If the workspace runtime is already running, `KnowledgeEntry` can reuse the existing socket client to avoid duplicate auth/client state.

**Pros**

- Avoids Socket.IO entirely on fresh KB deep links.
- Avoids joining the broad `authenticated` channel.
- Still supports all current KB CRUD calls because KnowledgePage only uses request/response service APIs today.

**Cons**

- Need to share or duplicate the token-refresh around-hook currently embedded in `useAgorClient`.
- If KB later needs live collaborative editing or live graph updates, it will need a scoped subscription story.

**Use as:** pair with Option B for the best product outcome.

### Option D — Server-side scoped realtime subscriptions

Change daemon socket publishing from global authenticated broadcast to scoped channels or explicit subscriptions. For example:

- default authenticated sockets receive only essential events (`server-info`, auth/OAuth events scoped to user);
- workspace clients call `subscribe({ groups: ['workspace'] })` and then receive sessions/boards/branches/etc.;
- KB clients call `subscribe({ groups: ['knowledge'] })` if live KB updates are needed;
- terminal/artifact special channels remain explicit.

**Pros**

- Solves background socket traffic at the source.
- Benefits every future lightweight route, not just KB.
- More secure and scalable than broadcasting everything to every authenticated socket.

**Cons**

- Larger backend and client protocol change.
- Must audit every existing listener and reconnect/refetch path.
- Requires migration strategy for old clients during development/deploy.

**Use as:** follow-up after UI route island or if measurement shows socket event traffic is material.

## Recommended phased plan

### Phase 0 — Instrument current behavior

Goal: make the baseline visible before changing architecture.

- Add temporary/dev-only logging or a small Playwright/Vitest harness to count service requests during a fresh `/kb/...` load.
- Capture browser Performance timings:
  - time to first meaningful KB shell,
  - time to active document rendered,
  - total number of HTTP requests,
  - Socket.IO connection opened yes/no,
  - number of service events received in 30s idle.
- Use a seeded instance with enough boards/branches/sessions to make the cost obvious.

No product behavior change.

### Phase 1 — Small safe PR: gate workspace store on fresh KB routes

Implement Option A narrowly:

- Add a route classifier helper, e.g. `isKnowledgeRoutePath(pathname)` with tests.
- In `AppContent`, compute whether the current tab has already started workspace runtime.
- Pass `enabled: workspaceShouldRun && !user?.must_change_password` to `useAgorData`.
- For fresh KB routes, bypass `InitialLoadingScreen` tied to workspace initial load.
- Pass `currentUser={user}` and an empty `userById` to KB when workspace data is not loaded.
- When navigating from KB to any non-KB route, start `useAgorData` and show existing workspace loading UI.
- When navigating from workspace to KB after workspace loaded, keep `useAgorData` enabled so state is preserved.

Expected win: eliminates workspace initial fetches on fresh KB links. It does not fully solve socket overhead.

Regression risks to test:

- `/kb` and `/knowledge` load without hanging on `initialLoadComplete`.
- Login and force password change still work from `/kb`.
- Back button from KB to `/` starts workspace load.
- Header Knowledge link from workspace preserves board state.
- `@` user mentions either degrade acceptably or lazily fetch users.

### Phase 2 — Extract route islands and lazy-load major bundles

Implement Option B:

- Move global auth/theme/router/error-boundary concerns into a small app shell.
- Extract existing workspace code from `AppContent` into `WorkspaceEntry` / `WorkspaceRuntimeProvider`.
- Extract KB route declarations into `KnowledgeRoutes` or `KnowledgeEntry`.
- Use `React.lazy` for:
  - `KnowledgePage`,
  - workspace `AgorApp`,
  - `MobileApp`,
  - demo route,
  - possibly onboarding/settings-heavy modules.
- Keep workspace runtime mounted once started, even when KB route is visible.

Expected win: fresh KB deep link downloads less app code and has an explicit runtime boundary.

### Phase 3 — REST-only KB runtime

Implement Option C:

- Factor the Feathers auth/refresh retry hook so both socket and REST clients can use it.
- Add `useAgorRestClient({ accessToken })` or `ApiClientProvider` with a mode.
- On fresh KB routes, use REST client only.
- If workspace runtime is already running, allow KB to reuse the socket client to avoid duplicate clients.
- Add lazy `useKbMentionUsers()` or a backend `users/mentionable` endpoint for editor mentions.

Expected win: no Socket.IO connection and no global authenticated event stream for external KB links.

### Phase 4 — Scoped realtime subscriptions, if needed

Implement Option D only after measuring real socket traffic and identifying need:

- Add subscription semantics to daemon channels.
- Make workspace opt into workspace events.
- Make KB opt into KB events only if live KB updates are a product requirement.
- Preserve reconnect refetch behavior for workspace.

Expected win: better scaling and cleaner realtime model across the product.

## Route/provider boundary sketch

Target conceptual tree:

```tsx
function RootApp() {
  return (
    <BrowserRouter basename={basename}>
      <ThemeProvider>
        <AntAppProviders>
          <AuthRuntimeProvider>
            <RuntimeCoordinatorProvider>
              <Routes>
                <Route path="/kb/*" element={<KnowledgeEntry />} />
                <Route path="/knowledge/*" element={<KnowledgeEntry />} />
                <Route path="/*" element={<WorkspaceEntry />} />
              </Routes>
            </RuntimeCoordinatorProvider>
          </AuthRuntimeProvider>
        </AntAppProviders>
      </ThemeProvider>
    </BrowserRouter>
  );
}
```

Runtime behavior:

```ts
const cameFromWorkspace = workspaceRuntime.status === 'running';
const kbClient = cameFromWorkspace ? workspaceRuntime.client : restClient;
```

Workspace runtime should own:

- socket `useAgorClient`,
- `useAgorData`,
- `ConnectionProvider` values for workspace mutation gates,
- session/board/repo/branch/user/MCP/artifact action handlers,
- onboarding wizard,
- device router/mobile workspace routes,
- event stream, task chime, favicon session status.

KB runtime should own:

- KB namespace/doc/search/graph/version calls,
- KB page/editor state,
- optional KB-local mention data,
- unsaved changes handling,
- minimal connection/error UI for KB requests.

Global shell should own:

- theme and Ant Design providers,
- auth config and token restore/refresh,
- login page,
- force password modal if this must block all authenticated surfaces,
- crash context with build SHA and signed-in email,
- possibly server-version drift detection using `/health` only until a socket exists.

## API/service considerations

### KB services are already separable

Daemon routes and hooks already expose KB under a clear service group:

- `kb/namespaces`
- `kb/documents`
- `kb/versions`
- `kb/search`
- `kb/graph`

`apps/agor-daemon/src/register-routes.ts` maps the `knowledge` service group independently, and `register-hooks.ts` applies auth/role checks to KB services directly. No large backend API change is required for REST-only KB reads/writes.

### User mention dependency should be narrowed

Current KB editor gets `userById` from full workspace data. For a real lightweight KB path, avoid loading all workspace maps just for mentions. Options:

- Add `users/mentionable` returning `{ user_id, email, name, avatar_url? }` for users visible to the current user.
- Or make `AutocompleteTextarea` accept a lazy async user search provider.
- Or defer user mention support until the editor enters edit mode.

### Realtime model should be explicit

Current server publishing model is all authenticated clients receive broad service events. A REST-only KB path sidesteps this. If KB later needs live updates, prefer a scoped `knowledge` subscription over reusing the global workspace socket.

## Measurement and test plan

### Manual network checklist

For a fresh external `/kb/global/...` load, verify after Phase 1:

- No requests to:
  - `sessions`
  - `boards`
  - `board-objects`
  - `board-comments`
  - `cards`
  - `card-types`
  - `repos`
  - `branches`
  - `mcp-servers`
  - `session-mcp-servers`
  - `gateway-channels`
  - `artifacts`
- KB requests are limited to expected KB services.
- No `InitialLoadingScreen` checklist for sessions/boards/branches appears.

For Phase 3, additionally verify:

- No Socket.IO connection is opened for fresh KB load.
- No authenticated-channel service-event traffic appears while idle on KB.

### Timing metrics

Capture before/after:

- navigationStart to KB shell visible;
- navigationStart to active document content visible;
- total transferred bytes before document visible;
- number of service calls before document visible;
- CPU time spent rendering before document visible.

### Regression tests

Automated tests to add as code changes land:

1. `isKnowledgeRoutePath()` unit tests for `/kb`, `/kb/x`, `/knowledge`, `/knowledge/x`, and non-KB routes.
2. App shell test: initial `/kb/...` route does not call `useAgorData` fetch services when workspace has not started.
3. Navigation test: workspace -> KB -> workspace preserves board/session state.
4. Navigation test: fresh KB -> `/` starts workspace load exactly once.
5. KB page tests for route-derived namespace/path and internal KB markdown link interception.
6. REST-only client tests for token refresh retry behavior shared with socket client.

### Production observability

Consider adding lightweight dev/diagnostic counters under a debug flag:

- workspace runtime status (`not-started` / `running`),
- workspace initial fetch duration,
- number of initial-load entities fetched,
- socket connected on route type,
- KB data fetch duration.

## Open questions

1. Should fresh KB links show the same app-level connection status as workspace, or only request-level KB errors?
2. Should onboarding wizard block KB for a new user, or should KB remain readable after login even before onboarding completion?
3. Is live KB collaboration or live graph update a near-term requirement? If yes, design scoped KB subscriptions earlier.
4. How important are `@` user mentions on read-only external deep links? This determines whether `users/mentionable` is Phase 1 or later.
5. Should `/knowledge` remain a permanent alias, or should canonical generated links always use `/kb` via `knowledgePath()`?

## Key recommendation

Do not make KB a cosmetic route inside the workspace shell. Make it a first-class lightweight surface that can run without workspace hydration. Preserve workspace state only after the workspace runtime has actually started in the current tab. This gives the desired product behavior for both cases:

- **External KB deep link:** fast, mostly independent KB app.
- **Internal KB navigation:** existing main app continues running in the background and returns instantly.
