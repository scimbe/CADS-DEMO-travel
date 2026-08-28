#!/usr/bin/env bash
# Builds the MLD routing graph from the pinned Bremen extract, using the OSRM image's own
# stock car profile. Idempotent: skips steps whose output already exists unless FORCE=1.
#
#   ./build-graph.sh          # build if missing
#   FORCE=1 ./build-graph.sh  # rebuild from scratch
set -euo pipefail
cd "$(dirname "$0")"

IMG="osrm/osrm-backend:v5.25.0"
DATA_DIR="$(pwd)/data"
PBF="bremen-latest.osm.pbf"
BASE="bremen-latest"

[ -f "$DATA_DIR/$PBF" ] || { echo "✗ $DATA_DIR/$PBF missing — run fetch-extract.sh first" >&2; exit 1; }

if [ "${FORCE:-0}" = "1" ]; then
  rm -f "$DATA_DIR/$BASE".osrm*
fi

run() {
  echo "▶ $*"
  docker run --rm -t -v "$DATA_DIR:/data" "$IMG" "$@"
}

if [ ! -f "$DATA_DIR/$BASE.osrm" ]; then
  run osrm-extract -p /opt/car.lua "/data/$PBF"
else
  echo "✓ $BASE.osrm already extracted"
fi

if [ ! -f "$DATA_DIR/$BASE.osrm.partition" ]; then
  run osrm-partition "/data/$BASE.osrm"
else
  echo "✓ $BASE.osrm.partition already present"
fi

# NOTE: osrm-partition (this OSRM version, v5.25.0) already writes an INTERIM
# bremen-latest.osrm.cells file as part of computing the bisection -- do not use its presence to
# decide whether osrm-customize has run (a real bug caught live in this build: that check skipped
# customize entirely, leaving no .osrm.mldgr and osrm-routed refusing to start under
# --algorithm mld). osrm-customize is what fills .cells with actual edge weights AND writes
# .osrm.mldgr (the multi-level-dijkstra graph) -- check for THAT file instead.
if [ ! -f "$DATA_DIR/$BASE.osrm.mldgr" ]; then
  run osrm-customize "/data/$BASE.osrm"
else
  echo "✓ $BASE.osrm.mldgr already present (customize already ran)"
fi

echo "✓ graph build complete — $DATA_DIR/$BASE.osrm* ready for osrm-routed --algorithm mld"
