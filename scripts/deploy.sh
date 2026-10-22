#!/usr/bin/env bash
# Deploy from your Mac to the server (SSH alias "agent-server", see docs/DEPLOYMENT.md).
#   ./scripts/deploy.sh            build + start (or update) the stack
#   ./scripts/deploy.sh build      only sync files and build the image, do not start
# Secrets: .env.production is copied to the server as /opt/agent-api/.env (mode 600). Nothing else secret is uploaded.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-agent-server}"
DIR="${DEPLOY_DIR:-/opt/agent-api}"
ENVFILE="${DEPLOY_ENV:-.env.production}"
MODE="${1:-up}"

[ -f "$ENVFILE" ] || { echo "Missing $ENVFILE (copy .env.example and fill it in)"; exit 1; }
DOMAIN="$(grep -E '^DOMAIN=' "$ENVFILE" | cut -d= -f2-)"
[ -n "$DOMAIN" ] || { echo "DOMAIN missing in $ENVFILE"; exit 1; }

echo "== sync files to $HOST:$DIR"
ssh "$HOST" "mkdir -p '$DIR' && command -v rsync >/dev/null || (apt-get update -qq && apt-get install -y -qq rsync >/dev/null)"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude data --exclude .git --exclude '.env*' \
  --exclude test --exclude docs --exclude HANDOFF.md --exclude AGENTS.md --exclude '*.zip' --exclude '.DS_Store' --exclude coverage --exclude 'scripts/_*' \
  ./ "$HOST:$DIR/"

echo "== install config (mode 600)"
ssh "$HOST" "umask 077; cat > '$DIR/.env'" < "$ENVFILE"

if [ "$MODE" = "build" ]; then
  echo "== build image only"
  ssh "$HOST" "cd '$DIR' && docker compose build"
  exit 0
fi

echo "== build and start"
ssh "$HOST" "cd '$DIR' && docker compose up -d --build --remove-orphans && docker compose ps"

echo "== wait for https://$DOMAIN/health"
for i in $(seq 1 45); do
  if curl -fsS -m 5 "https://$DOMAIN/health" 2>/dev/null; then echo; echo "up."; exit 0; fi
  sleep 4
done
echo "not reachable yet: check 'ssh $HOST \"cd $DIR && docker compose logs --tail 80\"'"
exit 1
