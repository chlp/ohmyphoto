#!/usr/bin/env bash
# Seed local R2 (wrangler dev --local) from a local mirror of the bucket layout:
#   r2/photos/<ref>.jpg  r2/previews/<ref>.jpg  r2/albums/<albumId>/info.json
set -euo pipefail
BUCKET=ohmyphoto
SRC=r2

find "$SRC" -type f | while read -r file; do
  key="${file#"$SRC"/}"
  echo "→ $key"
  npx wrangler r2 object put "$BUCKET/$key" --file "$file" --local
done
