#!/usr/bin/env bash
# Encode captured PNG frame sequences into web-ready demo videos.
#
#   ./encode.sh             # per-scene mp4s + stitched hero loop + poster
#   ./encode.sh --publish   # additionally copy final assets into ../public/videos/
#
# Inputs:  frames/<scene>/f%05d.png  (from capture.mjs, 3840×2160)
# Outputs: out/<scene>.mp4           (1080p, hero-embed grade)
#          out/<scene>-4k.mp4        (4K master, CRF 18)
#          out/agor-hero.mp4         (scenes stitched with fade-through-dark joins)
#          out/agor-hero-poster.jpg
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found — install it (brew install ffmpeg) and re-run." >&2
  exit 1
fi

SCENES=(multiplayer session artifact settings)
FPS=30
FADE=0.25
PUBLISH=false
[[ "${1:-}" == "--publish" ]] && PUBLISH=true

mkdir -p out

for scene in "${SCENES[@]}"; do
  if [[ ! -d "frames/$scene" ]]; then
    echo "frames/$scene missing — run: node capture.mjs --scene $scene" >&2
    exit 1
  fi

  echo "── encoding $scene"
  ffmpeg -y -loglevel error -framerate "$FPS" -i "frames/$scene/f%05d.png" \
    -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
    -c:v libx264 -profile:v high -crf 21 -preset slow -movflags +faststart -an \
    "out/$scene.mp4"

  ffmpeg -y -loglevel error -framerate "$FPS" -i "frames/$scene/f%05d.png" \
    -vf "scale=3840:2160:flags=lanczos,format=yuv420p" \
    -c:v libx264 -profile:v high -crf 18 -preset slow -movflags +faststart -an \
    "out/$scene-4k.mp4"

  # Fade-through-dark at both ends so the concat joins (and the loop wrap
  # point) are designed dips instead of jump cuts.
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "out/$scene.mp4")
  fade_out_start=$(echo "$dur - $FADE" | bc)
  ffmpeg -y -loglevel error -i "out/$scene.mp4" \
    -vf "fade=t=in:st=0:d=$FADE,fade=t=out:st=$fade_out_start:d=$FADE" \
    -c:v libx264 -profile:v high -crf 21 -preset slow -movflags +faststart -an \
    "out/$scene-faded.mp4"
done

echo "── stitching hero loop"
: >out/concat.txt
for scene in "${SCENES[@]}"; do
  echo "file '$scene-faded.mp4'" >>out/concat.txt
done
ffmpeg -y -loglevel error -f concat -safe 0 -i out/concat.txt -c copy \
  -movflags +faststart out/agor-hero.mp4

ffmpeg -y -loglevel error -i out/agor-hero.mp4 -vframes 1 -q:v 3 out/agor-hero-poster.jpg

# Responsive renditions for the docs hero <video> source ladder
# (≤720px viewport → 540p, ≤1280px → 720p, else 1080p).
echo "── responsive renditions"
ffmpeg -y -loglevel error -i out/agor-hero.mp4 \
  -vf "scale=1280:720:flags=lanczos" \
  -c:v libx264 -profile:v high -crf 22 -preset slow -movflags +faststart -an \
  out/agor-hero-720.mp4
ffmpeg -y -loglevel error -i out/agor-hero.mp4 \
  -vf "scale=960:540:flags=lanczos" \
  -c:v libx264 -profile:v main -crf 23 -preset slow -movflags +faststart -an \
  out/agor-hero-540.mp4

hero_bytes=$(stat -f%z out/agor-hero.mp4 2>/dev/null || stat -c%s out/agor-hero.mp4)
hero_mb=$(echo "scale=1; $hero_bytes / 1048576" | bc)
echo "agor-hero.mp4: ${hero_mb} MB"
if ((hero_bytes > 6 * 1024 * 1024)); then
  echo "⚠️  agor-hero.mp4 exceeds 6 MB — consider raising CRF or trimming scenes." >&2
fi

if $PUBLISH; then
  echo "── publishing to ../public/videos/"
  mkdir -p ../public/videos
  cp out/agor-hero.mp4 out/agor-hero-720.mp4 out/agor-hero-540.mp4 \
    out/agor-hero-poster.jpg out/multiplayer.mp4 ../public/videos/
fi

echo "done."
