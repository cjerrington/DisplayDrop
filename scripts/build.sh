#!/usr/bin/env bash
# Build a standalone DisplayDrop executable with Bun.
#
# Produces build/ containing:
#   displaydrop          - self-contained executable (no Node needed on target)
#   views/ migrations/   - app assets read at runtime
#   public/css/          - static assets
#   public/slides/       - empty; add slide images here (folder auto-created on first run)
#
# displaydrop.db is intentionally NOT included - the app creates it on first run.
# Requires Bun >= 1.4.0 on the build machine (same OS/arch as the target).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Prefer `bun` on PATH; fall back to the default Bun install location.
if command -v bun >/dev/null 2>&1; then
  BUN=bun
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "error: Bun is not installed (https://bun.sh)" >&2
  exit 1
fi

DEST="$ROOT/build"

rm -rf "$DEST"
mkdir -p "$DEST/public/slides"

"$BUN" build --compile app.js --outfile "$DEST/displaydrop"

cp -r views migrations "$DEST/"
cp -r public/css "$DEST/public/"

cat <<EOF
Built $DEST:
  displaydrop         standalone executable
  views/ migrations/  runtime assets
  public/css/         static assets
  public/slides/      empty (drop slides here)

displaydrop.db is created on first run. Deploy by copying the whole build/ folder.
EOF
