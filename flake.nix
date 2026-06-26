{
  description = "Agor dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        runtimeDeps = with pkgs; [ nodejs_22 pnpm git python3 pkg-config bash ];
        binPath     = pkgs.lib.makeBinPath runtimeDeps;

        # Helper: nix run app that cds into a subdir and runs pnpm dev.
        # Uses writeShellScriptBin (no shellcheck) with explicit PATH.
        mkDevApp = name: subdir:
          let
            script = pkgs.writeShellScriptBin name ''
              export PATH="${binPath}:$PATH"
              root="$(git rev-parse --show-toplevel)"
              cd "$root/${subdir}"
              exec pnpm dev
            '';
          in
          { type = "app"; program = "${script}/bin/${name}"; };

        daemonApp = mkDevApp "agor-daemon" "apps/agor-daemon";
        uiApp     = mkDevApp "agor-ui"    "apps/agor-ui";

        # nix run / nix run .#dev — build UI then start daemon
        # The daemon serves the built UI at /ui/ — no Vite dev server needed.
        devApp =
          let
            script = pkgs.writeShellScriptBin "agor-dev" ''
              export PATH="${binPath}:$PATH"
              root="$(git rev-parse --show-toplevel)"
              echo "Installing dependencies..."
              (cd "$root" && pnpm install --frozen-lockfile)
              echo "Building executor..."
              (cd "$root" && pnpm --filter @agor/executor build)
              echo "Building UI..."
              (cd "$root" && pnpm --filter @agor-live/client... build && pnpm --filter agor-ui build && rm -rf apps/agor-daemon/ui && cp -r apps/agor-ui/dist apps/agor-daemon/ui)
              exec pnpm --dir "$root/apps/agor-daemon" run dev:daemon-only
            '';
          in
          { type = "app"; program = "${script}/bin/agor-dev"; };
      in
      {
        # nix develop
        devShells.default = pkgs.mkShell {
          buildInputs = runtimeDeps;
          shellHook = ''
            echo "agor dev shell — node $(node -v), pnpm $(pnpm -v)"
          '';
        };

        # nix run           — daemon + UI together (default)
        # nix run .#dev     — same
        # nix run .#daemon  — daemon only
        # nix run .#ui      — UI only
        apps.daemon  = daemonApp;
        apps.ui      = uiApp;
        apps.dev     = devApp;
        apps.default = devApp;
      });
}
