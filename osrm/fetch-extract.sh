#!/usr/bin/env bash
# Downloads the pinned Bremen OSM extract and verifies it against its Geofabrik .md5 sidecar.
# See REGIONS.md for exactly which region/checksum this is and why.
set -euo pipefail
cd "$(dirname "$0")/data"

URL="https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf"
EXPECTED_MD5="0061299ee69f4bce070ea86e416ddc93"
FILE="bremen-latest.osm.pbf"

if [ -f "$FILE" ]; then
  ACTUAL_MD5="$(md5sum "$FILE" | awk '{print $1}')"
  if [ "$ACTUAL_MD5" = "$EXPECTED_MD5" ]; then
    echo "✓ $FILE already present and checksum-verified ($ACTUAL_MD5)"
    exit 0
  fi
  echo "! $FILE present but checksum mismatch ($ACTUAL_MD5 != $EXPECTED_MD5) — re-downloading"
  rm -f "$FILE"
fi

echo "Downloading $URL ..."
curl -fSL -C - -o "$FILE" "$URL"

ACTUAL_MD5="$(md5sum "$FILE" | awk '{print $1}')"
if [ "$ACTUAL_MD5" != "$EXPECTED_MD5" ]; then
  echo "✗ checksum mismatch: got $ACTUAL_MD5, expected $EXPECTED_MD5" >&2
  exit 1
fi
echo "✓ downloaded and checksum-verified ($ACTUAL_MD5)"
