import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { EvidenceRecord } from './operations';
import type { Investigation, InvestigationReport, Trace } from './investigations';

interface Stored { json: string }
export class InvestigationStore {
  private readonly db: Database;
  constructor(file: string) {
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS investigations(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('model','replay')), state TEXT NOT NULL, updated_at TEXT NOT NULL, deadline_at TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS investigations_active ON investigations(record_id,mode) WHERE state='running';
      CREATE INDEX IF NOT EXISTS investigations_recent ON investigations(updated_at DESC);`);
  }
  close(): void { this.db.close(); }
  private recover(): void {
    const expired = this.db.query<Stored, [string]>("SELECT json FROM investigations WHERE state='running' AND deadline_at<=?").all(new Date().toISOString());
    for (const item of expired) {
      const run = JSON.parse(item.json) as Investigation;
      run.state = 'failed'; run.error = '调查超时或应用已退出；已保留证据和中间过程，可重新调查'; run.updatedAt = new Date().toISOString();
      this.write(run);
    }
  }
  private write(run: Investigation): void {
    this.db.query('UPDATE investigations SET state=?,updated_at=?,json=? WHERE id=?').run(run.state, run.updatedAt, JSON.stringify(run), run.id);
  }
  list(recordId?: string): Investigation[] {
    this.db.transaction(() => this.recover()).immediate();
    const rows = recordId
      ? this.db.query<Stored, [string]>('SELECT json FROM investigations WHERE record_id=? ORDER BY updated_at DESC,id DESC LIMIT 30').all(recordId)
      : this.db.query<Stored, []>('SELECT json FROM investigations ORDER BY updated_at DESC,id DESC LIMIT 50').all();
    return rows.map(r => JSON.parse(r.json) as Investigation);
  }
  create(evidence: EvidenceRecord, mode: Investigation['mode'], retry = false): { run: Investigation; created: boolean } {
    return this.db.transaction(() => {
      this.recover();
      const existing = this.db.query<Stored, [string, string]>('SELECT json FROM investigations WHERE record_id=? AND mode=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(evidence.id, mode);
      if (existing) {
        const run = JSON.parse(existing.json) as Investigation;
        if (run.state === 'running' || !retry) return { run, created: false };
      }
      const active = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM investigations WHERE state='running'").get()?.n ?? 0;
      if (active >= 2) throw new Error('当前经营空间已有两项调查进行中，请等待完成或超时后重试');
      const now = new Date().toISOString();
      const run: Investigation = { id: randomUUID(), recordId: evidence.id, mode, state: 'running', createdAt: now, updatedAt: now, deadlineAt: new Date(Date.now() + 300000).toISOString(), evidence, trace: [], report: null, error: null, model: null };
      this.db.query('INSERT INTO investigations(id,record_id,mode,state,updated_at,deadline_at,json) VALUES (?,?,?,?,?,?,?)').run(run.id, evidence.id, mode, run.state, now, run.deadlineAt, JSON.stringify(run));
      return { run, created: true };
    }).immediate();
  }
  update(id: string, patch: { event?: Trace; report?: InvestigationReport; error?: string; model?: string }): Investigation {
    return this.db.transaction(() => {
      this.recover();
      const stored = this.db.query<Stored, [string]>('SELECT json FROM investigations WHERE id=?').get(id);
      if (!stored) throw new Error('调查不存在');
      const run = JSON.parse(stored.json) as Investigation;
      if (run.state !== 'running') return run;
      if (patch.event && run.trace.length < 32) run.trace.push(patch.event);
      if (patch.model) run.model = patch.model;
      if (patch.report) { run.report = patch.report; run.state = patch.report.reviewer.verdict === 'passed' ? 'completed' : 'needs_evidence'; }
      if (patch.error) { run.state = 'failed'; run.error = patch.error.slice(0, 1000); }
      run.updatedAt = new Date().toISOString(); this.write(run); return run;
    }).immediate();
  }
}
