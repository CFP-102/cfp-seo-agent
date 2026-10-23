#!/bin/sh
# Start the server in sandbox mode (no secrets, no payments, dummy data) and expose its MCP endpoint over stdio.
# Used by automated MCP checkers such as Glama: `initialize` and `tools/list` work; paid tools answer with an x402 requirement.
export NODE_ENV=development PAYMENT_MODE=off DATAFORSEO_MODE=sandbox DB_PATH=/tmp/app.db PORT=3000 LOG_LEVEL=warn
node dist/index.js >/dev/null 2>&1 &
i=0
until node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
  i=$((i+1)); [ "$i" -ge 30 ] && echo "server did not start" >&2 && exit 1; sleep 1
done
exec node node_modules/mcp-remote/dist/proxy.js http://127.0.0.1:3000/mcp --allow-http
