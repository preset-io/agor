#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docs_dir="$(cd "$script_dir/.." && pwd)"
source_svg="$docs_dir/public/logo.svg"
output_png="$docs_dir/public/apple-touch-icon.png"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert is required (install librsvg2-bin)." >&2
  exit 1
fi

# Apple touch icons require fixed raster output. librsvg preserves the
# canonical SVG's transparent outer canvas while rendering its fixed colors.
rsvg-convert \
  --format=png \
  --width=180 \
  --height=180 \
  --keep-aspect-ratio \
  "$source_svg" > "$output_png"

echo "Generated $output_png from $source_svg"
