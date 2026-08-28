#!/usr/bin/env bash
# Enable/disable the LOCAL travel-demo stack (osrm-car + bridge [+ Caddy origin, if
# TRAVEL_CERT_DIR is set]). Same shape as CADS-DEMO-sort/run-demo.sh's up|down|status|--selftest,
# but scoped to what v1 actually ships: no ct-agent service, no public hostname yet (see
# README.md's "Deployment status" — travel.bunsenbrenner.org needs operator confirmation first).
#
#   ./run-demo.sh up        # build + start osrm-car + bridge (+ origin if TRAVEL_CERT_DIR set)
#   ./run-demo.sh down      # stop everything
#   ./run-demo.sh status    # show container status
#   ./run-demo.sh --selftest  # check local prerequisites only, no network calls
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-up}"
COMPOSE="docker compose -f compose.travel-demo.yml"
ENV_FILE="${ENV_FILE:-.env}"

say() { printf '\033[36m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [ "$CMD" = "--selftest" ]; then
  say "Selftest: checking local prerequisites only (no network calls)"
  ok=1
  command -v docker >/dev/null || { echo "  ✗ docker not found"; ok=0; }
  command -v curl >/dev/null || { echo "  ✗ curl not found"; ok=0; }
  command -v node >/dev/null || { echo "  ✗ node not found"; ok=0; }
  [ -f compose.travel-demo.yml ] || { echo "  ✗ compose.travel-demo.yml missing"; ok=0; }
  [ -f Caddy.Dockerfile ] || { echo "  ✗ Caddy.Dockerfile missing"; ok=0; }
  [ -f osrm/Dockerfile ] || { echo "  ✗ osrm/Dockerfile missing"; ok=0; }
  [ -f bridge/Dockerfile ] || { echo "  ✗ bridge/Dockerfile missing"; ok=0; }
  [ -f bridge/server.js ] || { echo "  ✗ bridge/server.js missing"; ok=0; }
  [ -f osrm/data/bremen-latest.osrm.mldgr ] || echo "  ! osrm/data/bremen-latest.osrm.mldgr missing — run osrm/fetch-extract.sh then osrm/build-graph.sh"
  [ -f .env ] || echo "  ! .env missing — needed for /api/plan (LITELLM_BASE_URL/LITELLM_API_KEY), see README.md"
  [ "$ok" = "1" ] && echo "  ✓ all hard local prerequisites present" || die "selftest failed — see above"
  exit 0
fi

if [ "$CMD" = "down" ] || [ "$CMD" = "disable" ] || [ "$CMD" = "off" ]; then
  say "Taking the travel-demo stack down"
  $COMPOSE down
  printf '\033[32m✓ travel-demo is OFFLINE.\033[0m\n'
  exit 0
fi
if [ "$CMD" = "status" ]; then
  $COMPOSE ps
  exit 0
fi
[ "$CMD" = "up" ] || [ "$CMD" = "enable" ] || [ "$CMD" = "on" ] || die "unknown command '$CMD' (use: up | down | status | --selftest)"

command -v docker >/dev/null || die "docker not found."
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; } || echo "  ! no $ENV_FILE — /api/plan will 503 until LITELLM_BASE_URL/LITELLM_API_KEY are set"
[ -f osrm/data/bremen-latest.osrm.mldgr ] || die "osrm/data/bremen-latest.osrm.mldgr missing — run: bash osrm/fetch-extract.sh && bash osrm/build-graph.sh"

if [ -n "${TRAVEL_CERT_DIR:-}" ]; then
  say "TRAVEL_CERT_DIR set — starting osrm-car + bridge + travel-demo-origin"
  $COMPOSE --env-file "$ENV_FILE" up -d --build osrm-car bridge travel-demo-origin
else
  say "TRAVEL_CERT_DIR not set — starting osrm-car + bridge only (no public origin; this is the local-dev/acceptance-check workflow, see README.md)"
  $COMPOSE --env-file "$ENV_FILE" up -d --build osrm-car bridge
fi

say "Waiting for the bridge to report healthy"
BRIDGE_CID="$($COMPOSE ps -q bridge)"
for i in $(seq 1 30); do
  HEALTH="$(docker inspect --format='{{.State.Health.Status}}' "$BRIDGE_CID" 2>/dev/null || echo starting)"
  [ "$HEALTH" = "healthy" ] && break
  sleep 2
done
[ "$HEALTH" = "healthy" ] || { $COMPOSE logs --tail 50 osrm-car bridge; die "bridge did not become healthy in time"; }
printf '\033[32m✓ LIVE (locally) — bridge is healthy. Try: docker exec %s node -e "require(%s).get(%s)"\033[0m\n' \
  "$BRIDGE_CID" "'http'" "'http://127.0.0.1:8789/healthz'"
echo "  Run the full proof: ./scripts/acceptance-check.sh"
