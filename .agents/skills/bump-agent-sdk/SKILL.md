---
name: bump-agent-sdk
description: Upgrade a pinned agentic-tool SDK or runtime (Claude Agent SDK, Codex SDK, OpenCode, Gemini CLI core, Copilot SDK, Cursor SDK) and ship it to packaged installs through an agor-live release. Use when a new model or runtime fix needs a newer SDK, or when asked to bump, pin, or upgrade one of these SDKs.
---

# Bump an agentic-tool SDK

Packaged installs never load an agent SDK from `agor-live`. `agor install --sync` installs the
version-aligned wrapper `@agor-live/<tool>@<agor-live version>` from npm, and that wrapper pins
the SDK exactly. A published wrapper version is immutable, so **an SDK bump reaches packaged users
only through a new agor-live release**. Plan the bump as a release PR (step 5) unless the
maintainers explicitly want it to ride a later release.

## 1. Pick and verify the version

- `npm view <sdk> time --json | tail` — confirm the version is published. For the Claude Agent SDK
  and OpenCode, confirm every platform package (`<sdk>-darwin-arm64@<v>`, …) is published too.
- Read the SDK changelog or diff `sdk.d.ts` between the old and new tarballs (`npm pack <sdk>@<v>`)
  for breaking API changes.

## 2. Update every pin

Find all of them with `git grep -n "<old version>" -- ':!pnpm-lock.yaml' ':!CHANGELOG.md'`.

| Tool     | Wrapper runtime pin (exact)                                     | Other owners that must match                                                                                                                 |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `packages/agor-claude` → `@anthropic-ai/claude-agent-sdk`       | devDependencies in `packages/core`, `packages/executor`, `apps/agor-daemon`; `packages/executor/src/sdk-watchdog.ts`                         |
| Codex    | `packages/agor-codex` → `@openai/codex-sdk`                     | devDependencies in `packages/core`, `packages/executor`; `sdk-watchdog.ts`; version-specific comments (for example `runtime-diagnostics.ts`) |
| Gemini   | `packages/agor-gemini` → `@google/gemini-cli-core`              | devDependency copies; `sdk-watchdog.ts`                                                                                                      |
| OpenCode | `packages/agor-opencode` → `opencode-ai` and `@opencode-ai/sdk` | `packages/agentic-tool-opencode` (devDependency, `OPENCODE_VERSION`, `OPENCODE_INTEGRATION.sdkVersion`), `docker/Dockerfile` global install  |
| Copilot  | `packages/agor-copilot` → `@github/copilot-sdk`                 | `sdk-watchdog.ts`                                                                                                                            |
| Cursor   | `packages/agor-cursor` → `@cursor/sdk`                          | —                                                                                                                                            |

Also update `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` for the SDK **and its platform
packages**. No check enforces this list; stale entries break installs where an operator's pnpm
enforces `minimumReleaseAge`.

Then run `pnpm install` and confirm the `pnpm-lock.yaml` diff touches only the bumped packages.

For OpenCode, then run `pnpm --filter @agor-live/opencode generate:hosted-providers` to refresh the
hosted provider snapshot (`packages/agentic-tool-opencode/src/daemon/hosted-providers.generated.ts`);
its test fails until the snapshot matches `OPENCODE_VERSION`.

## 3. Prove the runtime does what the bump is for

If adding a model, also follow the owner map and model checklist in
[Publishing Agor](../../../PUBLISH.md#sdk-and-model-changes).

Tests mock the SDK, so they cannot show that a new model or fix works. For a model bump:

- Check the bundled runtime knows the model: `npm pack <sdk>-darwin-arm64@<v>`, then
  `strings package/claude | grep -o '{id:"<model-id>",family.\{0,1400\}'` shows its catalog entry
  (context window, `native_1m`, `1m_suffix`, default effort). Use this to decide registry shape,
  such as whether a `[1m]` variant exists.
- Run one real turn through the SDK from `packages/executor` with the model, and compare with the
  old version. Record what changed (for example, Claude Code 2.1.280 accepted Sonnet 5.5 but
  capped it at 200k context; 2.1.284 reports 1M).

## 4. Validate

- `node scripts/check-agentic-tool-packages.mjs` — exact pins, devDependency and watchdog
  alignment, wrapper versions, OpenCode version owners.
- `node scripts/sync-agor-live-deps.mjs --check`
- Targeted tests for the tool's SDK handler (for Claude:
  `vitest run src/sdk-handlers/claude` in `packages/executor`) and the model registry tests if
  models changed.

These checks do not detect a wrapper whose dependencies changed while its version stayed the same.
Step 5 is what prevents that drift.

## 5. Ship it as a release

Follow [Publishing Agor](../../../PUBLISH.md) for the aligned version bump and
changelog, post-merge tag, protected `npm` environment approval, and registry
verification before upgrading and running `agor install --sync`. Manual workflow
dispatch is a non-publishing preflight. A build or publishing approval alone is not
proof that the exact wrapper versions are available to installers.

Agor Cloud rollout is separate; use the runbook in its private repository. Keep
private cloud deployment details out of this skill and the public release guide.

Precedents: [#2830](https://github.com/preset-io/agor/pull/2830) (Opus 5.5 runtime, 0.26.6) and
[#2915](https://github.com/preset-io/agor/pull/2915) (Sonnet 5.5, 0.26.8).
