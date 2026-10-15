/** M0 persistence compatibility probe, not the production business database. */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(import.meta.dir, '../.runtime/sqlite-probe');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'compatibility.sqlite');
let db = new Database(file, { create: true, strict: true });
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
const previousVersion = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
if (previousVersion !== 0 && previousVersion !== 1) throw new Error('Unsupported probe schema');
db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('WAITING_APPROVAL', 'CLOSED'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS probe_outbox (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES probe_runs(run_id),
      idempotency_key TEXT NOT NULL UNIQUE
    ) STRICT;
    DELETE FROM probe_outbox;
    DELETE FROM probe_runs;
    PRAGMA user_version = 1;
  `);
})();
db.transaction(() => {
  db.query('INSERT INTO probe_runs (run_id, workspace_id, status) VALUES (?, ?, ?)').run('run-1', 'demo', 'WAITING_APPROVAL');
  db.query('INSERT INTO probe_outbox (event_id, run_id, idempotency_key) VALUES (?, ?, ?)').run('event-1', 'run-1', 'request-1');
})();
let rolledBack = false;
try {
  db.transaction(() => {
    db.query('UPDATE probe_runs SET status = ? WHERE run_id = ?').run('CLOSED', 'run-1');
    db.query('INSERT INTO probe_outbox (event_id, run_id, idempotency_key) VALUES (?, ?, ?)').run('event-2', 'run-1', 'request-1');
  })();
} catch { rolledBack = true; }
if (!rolledBack) throw new Error('Expected unique idempotency constraint');
const before = db.query<{ status: string }, []>("SELECT status FROM probe_runs WHERE run_id = 'run-1'").get();
if (before?.status !== 'WAITING_APPROVAL') throw new Error('Transaction did not roll back');
let foreignKeyRejected = false;
try { db.query('INSERT INTO probe_outbox (event_id, run_id, idempotency_key) VALUES (?, ?, ?)').run('orphan', 'missing', 'request-2'); }
catch { foreignKeyRejected = true; }
if (!foreignKeyRejected) throw new Error('Foreign key enforcement failed');
db.close();
db = new Database(file, { readonly: true, strict: true });
const restored = db.query<{ status: string }, []>("SELECT status FROM probe_runs WHERE run_id = 'run-1'").get();
db.close();
if (restored?.status !== 'WAITING_APPROVAL') throw new Error('Reopen recovery failed');
console.log(JSON.stringify({ ok: true, driver: 'bun:sqlite', bun: Bun.version, migration: 1, transaction_rollback: true, unique_idempotency: true, foreign_keys: true, restart_recovery: true }));
