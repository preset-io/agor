{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_22
    pnpm
    git
    python3      # needed by node-pty native build
    pkg-config
  ];

  shellHook = ''
    echo "agor dev shell — node $(node -v), pnpm $(pnpm -v)"
  '';
}
