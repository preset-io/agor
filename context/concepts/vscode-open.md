# Worktree "Open in VS Code" Feature

**Last updated: 2025-12-06 (Added: code-server browser support & connection mode configuration; distinction between global and user-level SSH configuration)**

## Goals & Requirements

- Provide "Open in VS Code" button in Worktree cards and Session panels.
- Single click opens the corresponding Worktree directory in VS Code.
- Supports three modes: Remote SSH, VS Code Tunnel, and Local.
- Default priority is Remote SSH (to avoid tunnel relay latency); falls back automatically based on priority if configuration is missing.
- Falls back to local `vscode://file` Deep Link if remote information is not configured.
- Added browser-based `code-server` entry point with URL template generation.

## Configuration Quick Reference

- Global configuration (shared by all users): `ide.vscode`, `ide.code_server` under `~/.agor/config.yaml`.
- User-level SSH configuration (per-user host/user/port/target and public key): Set via **User Settings → SSH / VS Code** in the frontend, stored in user profile (not config.yaml), and automatically written to the target user's `authorized_keys`.
- Configuration priority: User-level SSH > Global `ide.vscode.remote` > Tunnel > Local.

## Backend Implementation

1. **Configuration Entry** (`~/.agor/config.yaml`)

```yaml
ide:
  vscode:
    enabled: true            # Default true, can be disabled to hide the button
    preferred_mode: remote-ssh  # Default priority Remote SSH, options: tunnel / remote-ssh / local
    remote:
      host: my-server.com    # Remote SSH Host (required, otherwise falls back to local mode)
      port: 22               # Optional, default 22
      user: dev              # SSH user (required, otherwise falls back to local mode)
      target: agor-dev       # Optional, corresponds to Host alias in ~/.ssh/config; auto-generates user@host[:port] if not set
    tunnel:                  # Optional, only attempted if configured
      name: agor-prod-tunnel
      displayName: "Prod Tunnel"
  code_server:
    enabled: false           # Default disabled, shows "Open in code-server (browser)" button when enabled
    url_template: "https://codeserver.example.com/?folder={{encodeURIComponent worktree.path}}"
```

2. `apps/agor-daemon/src/services/worktrees.ts`

   - Added `getVSCodeTarget(worktreeId)`. Returns `VSCodeOpenResult` based on configuration.
   - **Priority order (configurable): preferred_mode → other modes.**
     - `preferred_mode: remote-ssh` (default): Prioritizes generating `vscode://vscode-remote/ssh-remote+<target>/<path>`.
     - If Tunnel is configured and `preferred_mode` is set to `tunnel`, generates `vscode://vscode-remote/tunnel+<name>/<path>` (following remote authority specification, frontend appends `windowId` to ensure new window).
     - Falls back to `vscode://file/<path>` if above conditions are not met, with `reason` in the result indicating local mode.
   - Added `getCodeServerTarget(worktreeId)`: Renders browser code-server link using `ide.code_server.url_template`.

3. `apps/agor-daemon/src/index.ts`

   - Exposes `/worktrees-open-vscode` custom service, method: `POST { worktreeId } → VSCodeOpenResult`.
   - Exposes `/worktrees-open-codeserver` custom service, method: `POST { worktreeId } → CodeServerOpenResult`.
   - Uses unified routing (not `:id`) to ensure both Socket client and REST can call.
   - Access control: `member` and above can trigger.

## Frontend Interaction

1. `App.tsx`

   - `handleOpenVSCode(worktreeId)` calls the above service and creates a hidden `<a>` tag to trigger deep link based on returned `uri`.
   - Displays toast based on `mode`, e.g., "VS Code Remote SSH triggered" for `remote-ssh`, "VS Code is opening worktree locally" for `local`.
   - Always appends unique `windowId` to ensure VS Code opens in a new window without overwriting the current project.
   - Added `handleOpenCodeServer(worktreeId)` to call `/worktrees-open-codeserver` and open the generated URL in browser.

2. Button Locations

   - Worktree card header (drag/terminal button area) adds "VS Code" and "code-server" buttons.
   - SessionPanel top-right adds VS Code / code-server entry points.
   - Settings > IDE / VS Code tab allows configuring `preferred_mode`, SSH/Tunnel info, and code-server URL template.

3. Fallback Notice

   - If the result is `local` with a `reason`, UI displays a warning indicating fallback to local mode due to missing configuration.

## Usage Flow

1. Global (shared by all users): Configure `~/.agor/config.yaml` on the machine running the daemon  
   - VS Code Tunnel:
     ```yaml
     ide:
       vscode:
         tunnel:
           name: agor-prod-tunnel
           displayName: "Prod Tunnel"
     ```
   - Remote SSH (global default, can be overridden by user-level):
     ```yaml
     ide:
       vscode:
         remote:
           host: my-server.com
           port: 22
           user: dev
           target: agor-dev
     ```
   - Browser code-server:
     ```yaml
     ide:
       code_server:
         enabled: true
         url_template: "https://codeserver.example.com/?folder={{encodeURIComponent worktree.path}}"
     ```
   - Other: `preferred_mode` (tunnel/remote-ssh/local), `enabled` toggle also under `ide.vscode`.
2. User-level (individual SSH per user): Fill in host/port/user/target and public key (.pub) in **User Settings → SSH / VS Code**. After saving:
   - Overrides current user's SSH configuration (higher priority than global).
   - Automatically writes to target account's `authorized_keys` (shows error in UI if permission denied).
3. Restart daemon (or wait for watch hot-reload to take effect).
4. Click "Open in VS Code" in UI, browser calls `vscode://...` with unique `windowId`, VS Code always opens in new window.
5. If code-server is enabled, click "Open in code-server (browser)" to open template-rendered link in new tab (template context: `worktree`, `repo`, with `encodeURIComponent` available).

## Common Issues

| Symptom | Possible Cause | Resolution |
| --- | --- | --- |
| Shows "VS Code integration not configured" | `ide.vscode.enabled` is false or service returns `enabled=false` | Enable in config.yaml |
| Auto-falls back to local mode (shows reason) | `tunnel.name` missing and `remote.host/user` not configured | Fill in Tunnel name or Remote SSH info |
| Deep Link doesn't launch VS Code | Browser blocks `vscode://` protocol or VS Code not installed locally | Check browser popup/local installation |
| Tunnel too slow | Default changed to prioritize Remote SSH, set preferred_mode to remote-ssh/local in Settings>IDE |  |
| Need browser-based access | Enable `ide.code_server.enabled=true` and fill in URL template | Settings>IDE Tab |

## Related Code

- `packages/core/src/config/types.ts`
- `apps/agor-daemon/src/services/worktrees.ts`
- `apps/agor-daemon/src/index.ts`
- `apps/agor-ui/src/App.tsx`
- `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx`
- `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx`
