#!/usr/bin/env bash
# Registers the new services at 402 Index (max. 10 requests per hour: run `./scripts/register-402index.sh 0 10` now and `./scripts/register-402index.sh 10 11` an hour later).
# 201 = received, 422 = probe failed (the answer says why). Safe to run again: duplicates are rejected, nothing is paid.
set -u
START="${1:-0}"; END="${2:-10}"
ENTRIES=(
  'https://agent.chiemgaufilms.com/api/v1/website-content	Agent Data API – Website Content	0.02	{"url":"https://example.com/"}'
  'https://agent.chiemgaufilms.com/api/v1/website-changes	Agent Data API – Website Changes	0.025	{"url":"https://example.com/","previous":{"url":"https://example.com/","text":"Old example."}}'
  'https://agent.chiemgaufilms.com/api/v1/regional-data	Agent Data API – Regional Places (Chiemgau)	0.01	{"region":"chiemgau"}'
  'https://agent.chiemgaufilms.com/api/v1/website-check	Agent Data API – Website Check (package)	0.04	{"url":"https://example.com/","link_urls":["https://example.com/about","https://example.com/contact"]}'
  'https://agent.chiemgaufilms.com/api/v1/open-data-search	Agent Data API – Open Data Catalog Search	0.01	{"source":"openbydata","query":"Chiemgau"}'
  'https://agent.chiemgaufilms.com/api/v1/video-project-plan	Agent Data API – Video Project Plan	0.08	{"goal":"recruiting","industry":"Metallbau","town":"Chieming","shoot_date":"2026-11-20","deliver_by":"2026-12-23","reel_count_max":10,"latitude":47.89,"longitude":12.54,"today":"2026-10-24"}'
  'https://agent.chiemgaufilms.com/api/v1/content-month-plan	Agent Data API – Content Month Plan	0.05	{"from":"2026-11-02","to":"2026-11-27","today":"2026-10-24","mix_counts":{"produkt":2,"mitarbeiter":2,"bts":2}}'
  'https://agent.chiemgaufilms.com/api/v1/content-plan-shift	Agent Data API – Content Plan Re-Schedule	0.02	{"posts":[{"key":"p1","title":"Produkt in 30 Sekunden","concept":"2026-11-03","shoot":"2026-11-06","edit":"2026-11-11","review":"2026-11-12","publish":"2026-11-13","shoot_group":"d1"},{"key":"p2","title":"Mitarbeiter stellt sich vor","concept":"2026-11-03","shoot":"2026-11-06","edit":"2026-11-16","review":"2026-11-17","publish":"2026-11-18","shoot_group":"d1"}],"move":{"post_key":"p1","step":"shoot","new_date":"2026-11-10"}}'
  'https://agent.chiemgaufilms.com/api/v1/shoot-day-plan	Agent Data API – Shoot Day Planner	0.03	{"shoots":[{"title":"Produkt in 30 Sekunden","recipe_id":"tpl-produkt-in-30-sekunden","location":"Showroom"},{"title":"Mitarbeiter stellt sich vor","recipe_id":"tpl-mitarbeiter-vorstellen","location":"Showroom"}],"first_date":"2026-11-10"}'
  'https://agent.chiemgaufilms.com/api/v1/video-recipes	Agent Data API – Video Recipes (Shot Lists)	0.01	{"category":"produkt","language":"en"}'
  'https://agent.chiemgaufilms.com/api/v1/shoot-location-check	Agent Data API – Shoot Location Check (package)	0.04	{"latitude":47.867,"longitude":12.44,"date":"2026-10-26"}'
)
for i in $(seq "$START" $((END - 1))); do
  [ -n "${ENTRIES[$i]:-}" ] || continue
  IFS=$'\t' read -r URL NAME PRICE BODY <<< "${ENTRIES[$i]}"
  PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"url":sys.argv[1],"name":sys.argv[2],"protocol":"x402","http_method":"POST","probe_body":sys.argv[4],"price_usd":float(sys.argv[3]),"payment_asset":"USDC","payment_network":"Base","category":"data","provider":"Burcleon Europe Limited","contact_email":"info@chiemgaufilms.de"}))' "$URL" "$NAME" "$PRICE" "$BODY")
  echo "== $NAME"
  curl -s -o /dev/stdout -w "\nHTTP %{http_code}\n" -X POST https://402index.io/api/v1/register -H "Content-Type: application/json" -d "$PAYLOAD"
  sleep 2
done
