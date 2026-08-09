#!/usr/bin/env bash
# Generates Subresource Integrity (SRI) hashes for the three pinned CDN
# scripts used by index.html, and prints ready-to-paste <script> tags.
#
# Why this is a separate step: the environment this app was built in has a
# restricted network allowlist and can't fetch these CDN URLs directly, so
# the hashes couldn't be computed automatically. Run this once, from a
# machine with normal internet access, before you deploy — then paste the
# printed `integrity="..."` attributes onto the matching <script> tags in
# index.html.
#
# Usage:
#   chmod +x generate-sri.sh
#   ./generate-sri.sh

set -euo pipefail

urls=(
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
  "https://cdn.jsdelivr.net/npm/fuse.js@7.5.0/dist/fuse.min.js"
)

echo "Fetching each script and computing its sha384 integrity hash..."
echo

for url in "${urls[@]}"; do
  tmp=$(mktemp)
  if ! curl -fsSL "$url" -o "$tmp"; then
    echo "FAILED to fetch: $url"
    echo "  (check the URL still resolves — CDN paths occasionally change)"
    rm -f "$tmp"
    echo
    continue
  fi
  hash=$(openssl dgst -sha384 -binary "$tmp" | openssl base64 -A)
  echo "$url"
  echo "  integrity=\"sha384-$hash\""
  echo
  rm -f "$tmp"
done

echo "Paste each integrity=\"...\" attribute onto the matching <script> tag"
echo "in index.html, alongside the existing crossorigin=\"anonymous\" attribute."
