# Codex permission/sandbox audit: `workspace-write` blocked shell reads

Date: 2026-05-25
Branch: `audit-codex-permission-model`

## Executive summary

The reported behavior is consistent with Codex's Linux sandbox failing during sandbox setup, not with POSIX file permissions or Agor branch ACLs. In `workspace-write` and `read-only`, Codex wraps spawned shell commands in its Linux sandbox (bubblewrap/bwrap by default). If the host/container blocks the required unprivileged user namespace or bubblewrap setup, even harmless commands such as `cat`, `sed`, or `ls` fail before the command runs. `danger-full-access` works because it removes Codex's sandbox wrapper entirely.

Agor currently passes Codex's three separate controls correctly enough for normal hosts:

1. filesystem sandbox: `sandboxMode`
2. approval policy: `approvalPolicy`
3. network access in workspace-write: `networkAccessEnabled`

However, Agor's UX still makes this failure unintuitive because the UI presents `workspace-write` as a permission level, while the real failure is a deployment capability problem: "this host cannot start Codex's workspace sandbox." Agor also has an undocumented `AGOR_CODEX_SANDBOX_MODE` override that can silently make the executor run a different sandbox than the session/UI says.

## Evidence from Agor code

### Types model Codex as split controls

Agor's canonical types already separate Codex's legacy permission mode from the actual Codex knobs. `CodexSandboxMode` is `read-only | workspace-write | danger-full-access`, `CodexApprovalPolicy` is `untrusted | on-request | on-failure | never`, and network access is separately documented as applying to workspace-write via `sandbox_workspace_write.network_access` (`packages/core/src/types/agentic-tool.ts:101-145`).

Session rows persist both a generic `permission_config.mode` and a Codex-specific `permission_config.codex` object with `sandboxMode`, `approvalPolicy`, and `networkAccess` (`packages/core/src/types/session.ts:220-232`).

### Current Agor mapping table

`mapToCodexPermissionConfig()` is the central mapping from Agor's generic/native `PermissionMode` union to Codex sub-config (`packages/core/src/utils/permission-mode-mapper.ts:131-176`):

| Agor mode | Codex sandbox | Codex approval | Network |
| --- | --- | --- | --- |
| `ask` | `read-only` | `untrusted` | `false` |
| `auto` | `workspace-write` | `on-request` | `false` |
| `on-failure` | `workspace-write` | `on-failure` | `false` |
| `allow-all` | `workspace-write` | `never` | `true` |

The system default for Codex is currently `allow-all`, which therefore maps to `workspace-write` + `never` + network-on (`packages/core/src/types/session.ts:85-112`). That is not `danger-full-access`; it still depends on the Codex sandbox backend working.

### Session creation fills Codex sub-config

For new sessions, the UI builds `permission_config.codex` from the selected mode plus overrides before creating the session (`apps/agor-ui/src/hooks/useSessionActions.ts:66-100`). The daemon-side resolver also always emits the Codex sub-config when a caller omits or partially specifies it (`packages/core/src/sessions/resolve-permission-config.ts:60-107`). The before-create hook centralizes this fallback for callers that omit permission/model config (`apps/agor-daemon/src/utils/apply-session-config-defaults.ts:1-107`).

### Executor passes those controls to Codex SDK thread options

The daemon sends the executor only the generic mode in the prompt payload (`apps/agor-daemon/src/register-services.ts:604-709`); the Codex executor then reloads the persisted session and reads `session.permission_config.codex` directly. It resolves `sandboxMode`, `approvalPolicy`, and `networkAccess`, logs them, sets `workingDirectory` to the branch path, and passes all three into Codex `ThreadOptions` (`packages/executor/src/sdk-handlers/codex/prompt-service.ts:855-940`). New threads call `startThread(threadOptions)`; existing threads call `resumeThread(..., threadOptions)` (`packages/executor/src/sdk-handlers/codex/prompt-service.ts:994-1029`).

### Hidden executor override can desynchronize UI and runtime

The executor applies `process.env.AGOR_CODEX_SANDBOX_MODE` over the session's stored sandbox mode with the inline comment: "workspace-write uses bwrap not available in pods; override with danger-full-access for k8s" (`packages/executor/src/sdk-handlers/codex/prompt-service.ts:866-872`). This is useful as an emergency operator escape hatch, but today it is invisible in the UI/session row. If set, a session can display `workspace-write` while actually running `danger-full-access`.

## Evidence from Codex docs/source

OpenAI's Codex sandbox documentation says sandboxing and approvals are separate controls: the sandbox is the technical boundary, and approval policy decides when Codex asks before crossing it. It also explicitly says spawned commands inherit the sandbox boundaries, including tools like `git`, package managers, and test runners.

The same docs list Linux/WSL2 prerequisites: install `bubblewrap`; Codex uses the first `bwrap` on `PATH`; if no `bwrap` is available it falls back to a bundled helper, but that helper requires unprivileged user namespace creation. The docs say Codex warns when `bwrap` is missing or when the helper cannot create the needed user namespace.

Codex's own Linux sandbox README confirms the implementation detail: on Linux, Codex prefers `bwrap`, falls back to bundled `bwrap` if missing, warns when bubblewrap cannot create user namespaces, and WSL1 is unsupported because it cannot create the required user namespaces. It also documents that when bubblewrap is active, it uses `--ro-bind / /`, writable roots, protected read-only subpaths such as `.git`/`.codex`, and `--unshare-user` / `--unshare-pid`.

Codex docs define the common modes this way: default permissions are `workspace-write` + `on-request`; `workspace-write` can read files, edit within the workspace, and run routine local commands; `danger-full-access` removes filesystem and network boundaries and should only be intentional.

Primary references:

- OpenAI Codex sandbox docs: `https://developers.openai.com/codex/concepts/sandboxing`
- OpenAI Codex config reference: `https://developers.openai.com/codex/config-reference`
- OpenAI Codex permission profiles docs: `https://developers.openai.com/codex/permissions`
- Codex Linux sandbox README: `https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md`

## Reproduction notes

In this Agor executor environment:

```text
codex-cli 0.128.0
bwrap: not found on PATH
/proc/sys/kernel/unprivileged_userns_clone: 1
/proc/sys/user/max_user_namespaces: 504390
unshare -Ur true: succeeds
```

Running `codex sandbox linux --config sandbox_mode="workspace-write" -- /bin/cat /tmp/agor-codex-sandbox-test.txt` did not reach `cat`; it panicked during sandbox setup while opening Codex's synthetic bubblewrap mount registry lock under `/tmp`. That is not the same failure Max reported, but it reinforces the diagnosis: `workspace-write` failures can occur before the requested read command executes. In Max's report, the prior agent's "bwrap needs unprivileged user namespaces and the kernel/container would not allow creating that namespace" explanation matches Codex's documented Linux prerequisite.

## Root cause for the user report

Likely root cause: the Agor runtime was in a Linux container/pod whose kernel, AppArmor/seccomp profile, or container configuration prevented Codex's Linux sandbox from creating the user namespace / bubblewrap sandbox. With `sandboxMode=workspace-write`, Codex tried to run even basic shell inspection inside that sandbox. Sandbox construction failed, so shell reads appeared to be blocked. With `sandboxMode=danger-full-access`, Codex skipped the sandbox path, so the same tooling worked.

Less likely based on the code trace:

- **Wrong cwd/workspace root:** Agor passes `branch.path` as Codex `workingDirectory` (`prompt-service.ts:916-940`).
- **Agor approval policy blocked bash:** The reported symptom also happened for reads. In Codex's `workspace-write` + `on-request`/`never`, routine local commands should run inside the sandbox; approval policy is separate from sandbox construction.
- **Unix branch ACL conflict:** `danger-full-access` would not fix an OS-level inability of the executor user to read the branch path. It specifically bypasses Codex's sandbox.
- **Command allowlist too strict:** `untrusted` has a trusted-command set, but Max reported `workspace-write`; `workspace-write` is a sandbox mode, not an allowlist.

## Recommendation

### 1. Treat sandbox availability as a deployment capability, not a user permission

Add an executor/daemon preflight for Codex Linux sandbox support, and surface the result in settings:

- Check `codex --version` and `codex sandbox linux -C <temp-git-repo> -- /bin/true` (or the smallest upstream-compatible bwrap/userns probe we can support).
- Cache/report: `codexSandboxBackend = ok | missing-bwrap | userns-blocked | setup-failed`.
- If `workspace-write` is selected but preflight is not `ok`, fail fast with an actionable message instead of letting the agent discover it via broken `cat`/`ls`.
- Only allow a fallback to `danger-full-access` through an explicit operator setting that says the outer Agor pod/VM/Unix isolation is the sandbox.

### 2. Do not silently rewrite `workspace-write` to `danger-full-access`

Keep the existing `AGOR_CODEX_SANDBOX_MODE` escape hatch only as a documented, noisy admin override. If it is set:

- log a startup warning,
- include the effective sandbox in session/task metadata,
- show a UI banner on Codex sessions,
- append a system message at task start when the effective sandbox differs from the stored session config.

This avoids the worst case: the user thinks they selected workspace confinement but the executor runs full filesystem access.

### 3. Expose Codex presets by separating filesystem, approvals, and network

Recommended UI model:

| Preset label | `sandboxMode` | `approvalPolicy` | Network | Use |
| --- | --- | --- | --- | --- |
| **Inspect only** | `read-only` | `untrusted` | off | review, planning, no writes |
| **Workspace (recommended)** | `workspace-write` | `on-request` | off | common coding; reads, edits, local commands inside branch |
| **Workspace auto** | `workspace-write` | `never` | off by default | headless/queue use where failures should return to model |
| **Workspace + network** | `workspace-write` | `on-request` or `never` | on | dependency install/API calls; elevated risk |
| **External sandbox / full access** | `danger-full-access` | `never` | n/a | only when Agor container/VM/Unix user is the security boundary |

Important copy: **Bash/read-file tooling is allowed inside `workspace-write` when the Codex sandbox backend is available.** If it is unavailable, switching approval policy will not help; the host must enable bubblewrap/user namespaces or the operator must choose an explicit external-sandbox/full-access mode.

### 4. Decouple network from `allow-all`

Agor currently maps `allow-all` to network-on (`permission-mode-mapper.ts:158-164`). That is surprising because OpenAI treats network access as a separate `sandbox_workspace_write.network_access` switch. For new presets, make network a separate toggle defaulting off even when approvals are `never`. Preserve existing stored sessions/user defaults as-is for compatibility, and migrate labels rather than values.

### 5. Backcompat plan

- Do not mutate existing `permission_config.codex` rows.
- Introduce named Codex presets in UI/config while continuing to accept the old fields.
- Keep old `PermissionMode` values (`ask`, `auto`, `on-failure`, `allow-all`) as compatibility aliases that expand to the explicit triplet.
- If an existing user default or session has `allow-all` with `networkAccess=true`, display it as **Legacy: workspace auto + network**.
- Add a one-time admin warning if `AGOR_CODEX_SANDBOX_MODE=danger-full-access` is present.

## Suggested next implementation steps

1. Add a Codex sandbox preflight service in the daemon/executor boundary and a small settings/status UI.
2. Replace hidden `AGOR_CODEX_SANDBOX_MODE` behavior with a documented config key and runtime warning path.
3. Update Codex settings copy to say `workspace-write` depends on Linux bubblewrap/user namespace support.
4. Add the named presets above while retaining raw advanced fields.
5. Consider changing only the **new default** network behavior after a migration note; do not alter existing stored sessions.
