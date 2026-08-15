import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Sqlite } from '@luoli/db';

export class MaintenanceService {
  constructor(private readonly db: Sqlite, private readonly databasePath: string, private readonly backupKeep: number, private readonly retentionDays: number) {}

  backup(label = 'manual'): string {
    const directory = resolve(dirname(this.databasePath), 'backup');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `luoli-${Date.now()}-${label}.db`);
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    const backups = readdirSync(directory).map((name) => join(directory, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const expired of backups.slice(this.backupKeep)) unlinkSync(expired);
    return path;
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  cleanup(now = Date.now()): Record<string, number> {
    const logCutoff = now - this.retentionDays * 86_400_000;
    const updateCutoff = now - 7 * 86_400_000;
    const approvalsCutoff = now - 90 * 86_400_000;
    const logs = this.db.prepare('DELETE FROM log_events WHERE ts<?').run(logCutoff).changes;
    const updates = this.db.prepare('DELETE FROM processed_updates WHERE ts<?').run(updateCutoff).changes;
    const sessions = this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now).changes;
    const approvals = this.db.prepare("DELETE FROM approvals WHERE requested_at<? AND state!='pending'").run(approvalsCutoff).changes;
    this.db.prepare("UPDATE approvals SET state='expired' WHERE state='pending' AND expires_at<?").run(now);
    this.checkpoint();
    return { logs, updates, sessions, approvals };
  }

  rebuildFts(): void {
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }
}
