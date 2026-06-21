# Design System — agor brag video

Brand source of truth. Mirrors agor.live exactly. Use these values; do not invent colors
or substitute fonts.

## Palette

| Role | Value | Notes |
|---|---|---|
| Background base | `#05070b` | Deepest dark teal-navy |
| Background mid | `#09111d` | Gradient midpoint |
| Background low | `#070b12` | Gradient lower band |
| Teal glow (TL) | `rgba(46,154,146,0.22)` | Top-left radial glow |
| Blue glow (TR) | `rgba(35,136,242,0.16)` | Top-right radial glow |
| Accent teal | `#7fe8df` | Primary accent (eyebrows, lines, highlights) |
| Deep teal | `#2e9a92` | Gradient start for buttons / lines |
| Mint | `#d9fb89` | Secondary accent, sparing |
| Warm amber | `#f0a23a` | Board reveal gradient (top) |
| Warm orange | `#e8731f` | Board reveal gradient + Mina cursor / labels |
| Ink (text) | `#f8fafc` | Primary text |
| Muted | `#aeb9c8` | Secondary text |
| Button ink | `#031311` | Dark text on teal pill |

- **Cool→warm contrast is the core idea:** dark-teal everywhere, then the warm amber/orange
  board is the one hot moment. Don't dilute it by adding orange elsewhere except the Mina cursor.

## Typography

- **Display:** system sans / Inter, weight **800–900**, very tight tracking **-0.05em**.
  Mirrors agor.live's `Meet your team of AI assistants.` headline. Big and confident.
- **Body / captions:** same family, weight 500–600, normal tracking.
- **Terminal (scene 1):** a monospace family (ui-monospace / "SF Mono" / Menlo).
- `font-variant-numeric: tabular-nums` on any numbers.

## Corners & depth

- Pill buttons: `border-radius: 999px`; primary fill `linear-gradient(135deg,#2e9a92,#7fe8df)`,
  text `#031311`.
- Cards / screenshots: rounded corners ~16–20px, soft layered shadow + faint teal edge glow.
- Depth = subtle glows, not hard drop shadows. The reveal board may carry a warm glow.

## Motion signature

- Confident, clean (app-store). Snappy entrances (0.3–0.6s), generous holds on readable text.
- One big cinematic move: the board reveal sweep (cool→warm) with a soft swell.
- Eases: vary them — `power3.out` / `expo.out` for entrances, `power2.inOut` for the sweep.

## Signature motif

- Thin **teal constellation/network lines** connecting small dots, drifting slowly, low
  opacity (~0.12–0.25) behind the dark-teal text scenes (hook + outro). Deterministic
  (seeded PRNG — no Math.random / Date.now). This is the agor.live parallax background.

## What NOT to do

- No generic SaaS gradients washing the whole frame (H.264 banding) — use radial/localized glows.
- No equalizer bars, waveforms, musical notes, or generic particle systems.
- No orange except the reveal board and the Mina cursor.
- No `#333`, `#3b82f6`, Roboto, or any off-brand color/font.
- No strobing or text-scaling tied to audio.
