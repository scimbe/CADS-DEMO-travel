#!/usr/bin/env bash
# The deliverable that closes CADS-agent-marketplace#28: a live, one-shot proof run against real
# infrastructure. Brings up osrm-car + bridge for real, queries the real engine two independent
# ways, runs the real LLM pipeline, mechanically verifies the LLM's answer against the engine's
# own raw output, and writes docs/acceptance-report.md.
#
#   ./scripts/acceptance-check.sh
#
# Requires .env with LITELLM_BASE_URL/LITELLM_API_KEY/LITELLM_DEFAULT_MODEL (see README.md).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f compose.travel-demo.yml"
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE missing — see README.md's Setup section" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

DATASET_MD5="0061299ee69f4bce070ea86e416ddc93"
[ -f osrm/data/bremen-latest.osrm.mldgr ] || { echo "✗ osrm/data/bremen-latest.osrm.mldgr missing — run osrm/fetch-extract.sh then osrm/build-graph.sh first" >&2; exit 1; }

say() { printf '\033[36m▶ %s\033[0m\n' "$*"; }

say "Bringing up osrm-car + bridge"
$COMPOSE --env-file "$ENV_FILE" up -d --build osrm-car bridge

say "Waiting for both healthchecks"
for i in $(seq 1 30); do
  OSRM_CID="$($COMPOSE ps -q osrm-car)"
  BRIDGE_CID="$($COMPOSE ps -q bridge)"
  OSRM_HEALTH="$(docker inspect --format='{{.State.Health.Status}}' "$OSRM_CID" 2>/dev/null || echo starting)"
  BRIDGE_HEALTH="$(docker inspect --format='{{.State.Health.Status}}' "$BRIDGE_CID" 2>/dev/null || echo starting)"
  [ "$OSRM_HEALTH" = "healthy" ] && [ "$BRIDGE_HEALTH" = "healthy" ] && break
  sleep 2
done
if [ "$OSRM_HEALTH" != "healthy" ] || [ "$BRIDGE_HEALTH" != "healthy" ]; then
  echo "✗ not healthy in time (osrm-car=$OSRM_HEALTH bridge=$BRIDGE_HEALTH)" >&2
  $COMPOSE logs --tail 50 osrm-car bridge >&2
  exit 1
fi
echo "  osrm-car=$OSRM_HEALTH bridge=$BRIDGE_HEALTH"

say "Copying the acceptance script into the running bridge container and running it"
docker cp scripts/run-acceptance.js "$BRIDGE_CID":/app/run-acceptance.js
RESULT_JSON="$(mktemp)"
if ! docker exec -e LITELLM_BASE_URL="$LITELLM_BASE_URL" "$BRIDGE_CID" node /app/run-acceptance.js > "$RESULT_JSON"; then
  echo "  (acceptance script exited non-zero — still rendering the report so the failure is visible)"
fi
cat "$RESULT_JSON" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d)}catch(e){console.error('✗ run-acceptance.js did not print valid JSON:',e.message);process.exit(1)}})"

say "Rendering docs/acceptance-report.md"
node scripts/render-report.js "$RESULT_JSON" "$DATASET_MD5" > docs/acceptance-report.md
rm -f "$RESULT_JSON"

OVERALL="$(node -e "const t=require('fs').readFileSync('docs/acceptance-report.md','utf8');console.log(/Overall: \*\*PASS\*\*/.test(t))")"
if [ "$OVERALL" = "true" ]; then
  printf '\033[32m✓ ACCEPTANCE CHECK PASSED — see docs/acceptance-report.md\033[0m\n'
  exit 0
else
  printf '\033[31m✗ ACCEPTANCE CHECK FAILED — see docs/acceptance-report.md\033[0m\n'
  exit 1
fi
