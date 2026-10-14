#!/usr/bin/env bash
# Generates fixtures/brand-assets/brand-video.mp4: ~50 MB of seeded ffmpeg noise.
# It is larger than the 32 MB Artifacts blob limit on purpose, so intake must
# route it to R2 instead of Git. The file is git-ignored; never commit it.
#
#   fixtures/brand-assets/scripts/make-video.sh [out.mp4] [size-MB]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$(cd "$here/.." && pwd)/brand-video.mp4}"
size_mb="${2:-50}"

command -v ffmpeg >/dev/null || { echo "make-video: ffmpeg is required" >&2; exit 1; }

# Per-frame random noise is incompressible, so a high fixed bitrate fills the
# file; -fs stops writing at the size cap and the mp4 is still finalized.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x0f766e:s=1280x720:r=30,noise=alls=100:allf=t+u:all_seed=42" \
  -t 120 -c:v libx264 -preset ultrafast -b:v 40M -maxrate 40M -bufsize 80M \
  -pix_fmt yuv420p -movflags +faststart -fs "${size_mb}M" "$out"

bytes=$(stat -c %s "$out" 2>/dev/null || stat -f %z "$out")
echo "wrote $out ($bytes bytes)"
