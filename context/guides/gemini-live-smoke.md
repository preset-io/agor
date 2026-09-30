# Gemini packaged-agent smoke

`.github/workflows/gemini-live-smoke.yml` builds and installs the exact release
artifacts on `main`, nightly at 03:23 UTC and by manual dispatch. It runs only
Gemini. It is not a pull-request check, a reusable workflow, or a replacement
for the required offline SDK contract check.

## Environment setup (repository administrator)

Before adding a key, create the GitHub environment **`gemini-live-smoke`**:

- Deployment branches and tags: **Selected branches and tags**, one **branch**
  rule named **`main`**. Do not add a tag rule or wildcard.
- **No required reviewers** and no wait timer, so nightly execution is unattended.
- Store **`GEMINI_API_KEY`** as an **environment secret**, not a repository or
  organization secret. Use an AI Studio key funded for this smoke.

The YAML guard is defense in depth, not environment protection. GitHub environment
settings are not created by this change. Verify the server-side restriction with
a non-`main` dispatch before enabling secrets; it must not reach the secret job.
See [GitHub's environment configuration documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

No PR-triggered job receives this key. Build/install steps have no key in their
environment; only availability and live-execution steps receive it. A missing
key prints **not validated** in the job log and summary and skips build/inference.
That successful workflow exit is **not a passing live validation**. Provider
errors, unavailable capacity, failed assertions and timeouts fail the live job;
there is no automatic prompt retry.

## What it proves

The harness imports the installed package's `executeGeminiTask`, uses the real
adapter and managed Gemini SDK, and runs each task in a fresh process. A small
fixture replaces daemon transport/key resolution and streaming broadcast; real
Agor repositories persist sessions, tasks and messages in a disposable SQLite
database. Task completion is written by the product executor, not the harness.
This is packaged-agent proof, not daemon authentication, queue/Stop routing, HA,
or tenant-isolation proof. Those need their own integration QA.

- **Accept edits:** read a source file, edit it and `package.json`, call an Agor
  HTTP MCP fixture, then recall a random 192-bit nonce in a new executor process.
- **Bypass:** execute `env` and a shell write, complete one loaded sub-agent,
  interrupt a foreground tool after its start marker exists, then complete a
  follow-up in another process.

Assertions read stored task statuses and paired successful tool results plus
filesystem effects. Assistant claims are not evidence; exact nonce recall is the
only prose exception. Agent processes have `GITHUB_SHA` and `SURFACE` **unset**.
An ordinary synthetic `GITHUB_TOKEN` must survive in `env`, while the provider
key must not. This prevents SDK GitHub-specific environment stripping from
masquerading as Agor credential isolation.

Each run owns a temporary home, workspace and database. The key reaches the task
process via IPC and the product key resolver, never argv or a credential file.
The runner checks key absence in transcript, files and captured process output,
and private task-temp cleanup. Raw errors/output, prompts, transcripts and SDK
homes are never uploaded or printed; only fixed stage/verdict text is emitted.
The temporary tree and task process groups are removed on completion/failure.

## Local and offline checks

After `packages/agor-live/build.sh --skip-install`, install `agor-live`, its client
and the matching `@agor-live/gemini` tarball exactly as the workflow does. With an
explicitly authorized live key in the environment, run:

```sh
node packages/executor/scripts/gemini-live-smoke.mjs \
  /path/to/install/node_modules/agor-live /path/to/install/tools
```

The tools directory uses the normal `<release-version>/gemini` managed layout.
The smoke uses the product's default Gemini model. Do not run it with a real key
when only offline checks are authorized.

Without any provider call:

```sh
pnpm --filter @agor/executor test:gemini-smoke
pnpm --filter @agor/executor test:gemini-contract
```

The former checks the no-key CLI/summary and assertion false-positive cases.
Its optional `GEMINI_SMOKE_TEST_PACKAGE` and `GEMINI_SMOKE_TEST_TOOLS` paths add a
packaged missing-key probe: real fixture DB and task handler, no inference.
Neither is live validation. After merge, #2852 needs one **dispatched**, fully
validated run on `main` before closure; nightly/no-key/offline results do not
satisfy that gate.
