import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.js";

/** Create a consistent snapshot, then enforce payload retention in every retained backup. */
export function backupLedger(database: string, directory: string, retentionDays: number, now = new Date()): string {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("Invalid retention period");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const filename = `app-${now.toISOString().slice(0, 10)}.db`;
  const temporary = join(directory, `.backup-${process.pid}.db`);
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    source.prepare("VACUUM INTO ?").run(temporary);
    chmodSync(temporary, 0o600);
    sanitize(temporary, retentionDays, now);
    // Preserve the previous successful snapshot if creation or verification fails.
    renameSync(temporary, join(directory, filename));
  } finally {
    source.close();
    rmSync(temporary, { force: true });
  }
  const files = readdirSync(directory).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const name of files.slice(0, -14)) rmSync(join(directory, name));
  for (const name of files.slice(-14)) {
    if (name !== filename) sanitize(join(directory, name), retentionDays, now);
  }
  return filename;
}

function sanitize(file: string, retentionDays: number, now: Date): void {
  chmodSync(file, 0o600);
  const snapshot = new Store(file);
  try {
    snapshot.db.exec("PRAGMA secure_delete = ON");
    snapshot.purgeOldPayloads(retentionDays, now);
    snapshot.db.exec("VACUUM");
    const check = snapshot.db.prepare("PRAGMA integrity_check").get();
    if (check?.integrity_check !== "ok") throw new Error("Backup integrity check failed");
  } finally {
    snapshot.db.close();
  }
}
