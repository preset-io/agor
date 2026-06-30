#!/usr/bin/env bash
#
# Restore the binary assets that are gitignored (screenshots, harness logos, music
# bed) so the composition can be rendered. Run from this directory:
#
#     ./recreate-assets.sh
#
# Everything else (index.html, design.md, SFX, cue presets, audio-data.js) is
# committed, so after this runs the project renders deterministically.
#
set -euo pipefail
cd "$(dirname "$0")"

PUB=../public
A=composition/assets
mkdir -p "$A/screenshots/marketing" "$A/tools" "$A/music"

echo "==> Restoring screenshots from the docs site (../public) ..."
cp "$PUB"/screenshots/{board-hero,conversation_full_page,scheduler-modal,mcp_environment,assistants-list}.png "$A/screenshots/"
cp "$PUB"/images/{knowledge-hero,artifacts-hero}.png "$A/screenshots/"
cp "$PUB"/screenshots/marketing/{agor-marketing-facepile-tooltip,agor-marketing-cursor-indicator,agor-marketing-social-comment-context,agor-marketing-slack-thread}.png "$A/screenshots/marketing/"
# Scene 4 uses a dimmed duplicate of the hero board (dimmed via CSS at runtime)
cp "$A/screenshots/board-hero.png" "$A/screenshots/board-hero-dim.png"

echo "==> Restoring harness logos from ../public/tools ..."
cp "$PUB"/tools/{claude-code,codex,gemini,copilot,opencode}.png "$A/tools/"

echo "==> Baking the 40s music bed ..."
SRC="$A/music/adventure-epic-478847.mp3"
if [ ! -f "$SRC" ]; then
  cat <<EOF

  !! Missing music track: $SRC

     Pixabay blocks scripted downloads (Cloudflare), so grab it by hand:
       1. Open  https://pixabay.com/music/adventure-epic-478847/
          ("Adventure Epic" by Kornev — Pixabay Content License, no attribution required)
       2. Click Download, save the mp3 as:  $SRC
       3. Re-run ./recreate-assets.sh

EOF
  exit 1
fi
# 0-40s window, tiny fade-in + 1.2s fade-out — must match assets/music/cues/agor-epic-40s.*
ffmpeg -y -loglevel error -t 40 -i "$SRC" \
  -af "afade=t=in:st=0:d=0.08,afade=t=out:st=38.8:d=1.2" \
  -c:a libmp3lame -q:a 2 "$A/music/agor-epic-40s.mp3"

cat <<EOF

==> Done. Render with:
      cd composition && npx hyperframes render --output ../brag.mp4

    (audio-data.js is already committed, so no audio re-extraction is needed.
     If you re-bake or swap the track, regenerate it via the hyperframes
     audio-reactive workflow — see ../launch-video/README.md.)
EOF
