#!/usr/bin/env bash
# Consistent backup of the SQLite ledger (run ON the server from /opt/agent-api). Keeps the last 14 backups.
# Run every six hours so backup payload retention follows the application cleanup interval.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T app node --input-type=module -e '
import { backupLedger } from "./dist/lib/backup.js";
process.umask(0o077);
const file = backupLedger(process.env.DB_PATH || "/data/app.db", "/data/backups", Number(process.env.RETENTION_DAYS || 30));
console.log("backup verified:", file);
'
