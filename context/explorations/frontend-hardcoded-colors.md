# Frontend hard-coded color audit

Initial Biome/GritQL audit on 2026-07-10: **226 diagnostics across 59 files**
(177 TSX, 38 TS, 11 CSS). This is lower than raw-regex estimates because the
rules emit one AST diagnostic per color-bearing value and avoid comments,
issue references, IDs, and hashes.

Preliminary classification (path-based, requiring human confirmation):

| Classification              | Diagnostics |
| --------------------------- | ----------: |
| Tests/fixtures              |          49 |
| Theme definitions/editor    |          16 |
| Terminal/ANSI               |          33 |
| Syntax/diff                 |          13 |
| Marketing screenshots       |          17 |
| Canvas/data visualization   |          24 |
| Brand asset                 |           1 |
| Ordinary UI or needs review |          73 |

The rules are in `apps/agor-ui/biome-plugins/`. The initial findings were
resolved with AntD components/tokens or documented narrow suppressions for
intentional exact-color domains. Plugin diagnostics now run as errors through
`apps/agor-ui/biome.json`, so new hard-coded colors fail `pnpm lint`.

Final result: **zero unsuppressed diagnostics**. Ordinary UI now uses AntD
components, semantic tokens, or theme CSS variables. Seventeen files retain
documented exceptions for exact-purpose domains: terminal/ANSI, syntax diffs,
theme seeds and color-parser tests, data visualization, persisted canvas
palette fixtures, brand artwork, and demo-only marketing screenshots. Tests
otherwise use distinctive `ConfigProvider` tokens or semantic values rather
than copying AntD's default hex palette.
