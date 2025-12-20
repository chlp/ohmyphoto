BUCKET=ohmyphoto
SRC=albums

find "$SRC" -type f | while read -r file; do
  key="${file}"   # albums/123/info.json → albums/123/info.json

  echo "→ $key"
  npx wrangler r2 object put "$BUCKET/$key" \
    --file "$file" \
    --local
done