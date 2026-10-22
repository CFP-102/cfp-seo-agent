#!/usr/bin/env bash
# Calls a running local server against the DataForSEO SANDBOX (free dummy data).
# Usage: ./scripts/sandbox-smoke.sh [base_url]
set -euo pipefail
BASE="${1:-http://localhost:3000}"

echo "== health";    curl -sS "$BASE/health"; echo
echo "== services";  curl -sS "$BASE/api/v1/services" | head -c 600; echo
echo "== preflight"; curl -sS -X POST "$BASE/api/v1/preflight/keyword-metrics" \
  -H 'content-type: application/json' -d '{"keywords":["seo tools"],"location_code":2276,"language_code":"de"}'; echo

echo "== keyword-metrics (sandbox)"
RESP=$(curl -sS -X POST "$BASE/api/v1/keyword-metrics" \
  -H 'content-type: application/json' -d '{"keywords":["seo tools","keyword research"],"location_code":2840,"language_code":"en"}')
echo "$RESP" | head -c 1500; echo

ID=$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.request_id||"")+" "+(j.result_token||""))}catch{}})')
set -- $ID
if [ -n "${2:-}" ]; then
  echo "== re-fetch result $1"
  curl -sS "$BASE/api/v1/results/$1" -H "authorization: Bearer $2" | head -c 300; echo
fi
