/** Bun worker only. Jobs contain deterministic reads, never model/approval/execution authority. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CheckConfigSchema } from './check-types';
import { evidenceTimeIssue } from './evidence-policy';
import type { CheckConfig, CheckConfigInput, CheckFinding, CheckRun, ChecksView, CheckResult } from './check-types';
import type { EvidenceRecord } from './operations';
import type { SignalRecord } from './signals';
type Records = Iterable<EvidenceRecord | SignalRecord>;
const iso = (time: number) => new Date(time).toISOString();
const floorSlot = (time: number, interval: number) => Math.floor(time / (interval * 60000)) * interval * 60000;
export class ScheduledChecks {
  private db: Database;
  constructor(file: string, private workspaceId: string, private readRecords: (source: 'demo' | 'csv') => Records, private clock: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA cache_size=-65536');
      const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
      if (version > 1) throw new Error('巡检数据库版本高于当前程序，请更新应用');
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS check_owner(id INTEGER PRIMARY KEY CHECK(id=1),workspace TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS check_config(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS check_runs(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,slot TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(revision,slot));
        CREATE INDEX IF NOT EXISTS check_recent ON check_runs(started_at DESC,id);
        CREATE INDEX IF NOT EXISTS check_active ON check_runs(status,started_at);
        CREATE TABLE IF NOT EXISTS check_findings(key TEXT PRIMARY KEY,first_run TEXT NOT NULL,json TEXT NOT NULL);
        PRAGMA user_version=1;`);
      this.db.transaction(() => {
        this.db.query('INSERT OR IGNORE INTO check_owner VALUES(1,?)').run(workspaceId);
        if (this.db.query<{ workspace: string }, []>('SELECT workspace FROM check_owner WHERE id=1').get()!.workspace !== workspaceId) throw new Error('巡检工作空间不一致');
        const now = this.clock();
        this.db.query('INSERT OR IGNORE INTO check_config VALUES(1,?)').run(JSON.stringify({ enabled: false, intervalMinutes: 60, source: 'demo', revision: 1, configuredAt: iso(now), startsAt: iso(floorSlot(now, 60)) }));
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  config(): CheckConfig { return JSON.parse(this.db.query<{ json: string }, []>('SELECT json FROM check_config WHERE id=1').get()!.json) as CheckConfig; }
  configure(expectedRevision: number, input: CheckConfigInput): ChecksView {
    const parsed = CheckConfigSchema.parse(input);
    this.db.transaction(() => {
      const current = this.config();
      if (current.revision !== expectedRevision) throw new Error('巡检配置已变更，请刷新后重试');
      if (parsed.enabled === current.enabled && parsed.intervalMinutes === current.intervalMinutes && parsed.source === current.source) return;
      const now = this.clock();
      const next: CheckConfig = { ...parsed, revision: current.revision + 1, configuredAt: iso(now), startsAt: iso(floorSlot(now, parsed.intervalMinutes)) };
      this.db.query('UPDATE check_config SET json=? WHERE id=1').run(JSON.stringify(next));
    }).immediate();
    return this.view();
  }
  private save(run: CheckRun) {
    this.db.query('UPDATE check_runs SET status=?,started_at=?,json=? WHERE id=?').run(run.status, run.startedAt, JSON.stringify(run), run.id);
  }
  private recover(now: number) {
    this.db.transaction(() => {
      const stale = this.db.query<{ json: string }, [string]>("SELECT json FROM check_runs WHERE status='running' AND started_at<=?").all(iso(now - 120000));
      for (const stored of stale) { const run = JSON.parse(stored.json) as CheckRun; run.status = 'interrupted'; run.finishedAt = iso(now); run.error = '巡检进程中断或超过两分钟租约；未生成完整结果，可显式重试。'; this.save(run); }
    }).immediate();
  }
  view(): ChecksView {
    const now = this.clock(); this.recover(now);
    const config = this.config(); const current = floorSlot(now, config.intervalMinutes); const start = Date.parse(config.startsAt);
    const possible = Math.max(0, Math.floor((current - start) / (config.intervalMinutes * 60000)) + 1);
    const pendingSlots: string[] = [];
    for (let i = Math.min(24, possible) - 1; i >= 0; i--) {
      const slot = iso(current - i * config.intervalMinutes * 60000);
      if (!this.db.query('SELECT id FROM check_runs WHERE revision=? AND slot=?').get(config.revision, slot)) pendingSlots.push(slot);
    }
    return { config, now: iso(now), pendingSlots, olderSlotsExcluded: Math.max(0, possible - 24), runs: this.db.query<{ json: string }, []>('SELECT json FROM check_runs ORDER BY started_at DESC,id DESC LIMIT 30').all().map(r => JSON.parse(r.json) as CheckRun) };
  }
  run(trigger: CheckRun['trigger']): ChecksView {
    const view = this.view();
    if (trigger === 'scheduled' && !view.config.enabled) return view;
    const current = iso(floorSlot(this.clock(), view.config.intervalMinutes));
    if (current < view.config.startsAt) throw new Error('系统时间早于配置生效时间，请核对时钟');
    const slots = trigger === 'catchup' ? view.pendingSlots.slice(0, 6) : [current];
    let created = 0;
    for (const slot of slots) if (this.execute(view.config, slot, trigger)) created++;
    return { ...this.view(), lastAction: { created, reused: slots.length - created } };
  }
  retry(id: string): ChecksView {
    this.recover(this.clock());
    const stored = this.db.query<{ json: string }, [string]>('SELECT json FROM check_runs WHERE id=?').get(id);
    if (!stored) throw new Error('巡检记录不存在');
    const run = JSON.parse(stored.json) as CheckRun;
    if (run.config.revision !== this.config().revision) throw new Error('配置已更新，请在当前配置下检查，不能重试旧配置任务');
    if (run.status !== 'failed' && run.status !== 'interrupted') throw new Error('仅失败或中断的巡检可重试');
    this.execute(run.config, run.slot, run.trigger, id);
    return this.view();
  }
  private execute(config: CheckConfig, slot: string, trigger: CheckRun['trigger'], retryId?: string): boolean {
    const claimed = this.db.transaction(() => {
      // Fence a concurrent configuration change before claiming any work.
      if (this.config().revision !== config.revision) throw new Error('巡检配置已更新，本轮未继续');
      const existing = this.db.query<{ json: string }, [number, string]>('SELECT json FROM check_runs WHERE revision=? AND slot=?').get(config.revision, slot);
      const previous = existing ? JSON.parse(existing.json) as CheckRun : null;
      if (previous && (!retryId || previous.id !== retryId || !['failed', 'interrupted'].includes(previous.status))) return null;
      if (previous && previous.attempt >= 3) throw new Error('本时段已达到三次尝试上限，请修复数据后等待下个时段');
      const history = previous ? [...(previous.history ?? []), { attempt: previous.attempt, startedAt: previous.startedAt, finishedAt: previous.finishedAt, status: previous.status, error: previous.error }] : [];
      const run: CheckRun = { id: previous?.id ?? randomUUID(), config, slot, trigger, status: 'running', attempt: (previous?.attempt ?? 0) + 1, startedAt: iso(this.clock()), finishedAt: null, error: null, result: null, history };
      if (previous) this.save(run);
      else this.db.query('INSERT INTO check_runs VALUES(?,?,?,?,?,?)').run(run.id, config.revision, slot, run.status, run.startedAt, JSON.stringify(run));
      return run;
    }).immediate();
    if (!claimed) return false;
    try {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS check_candidates(key TEXT NOT NULL,json TEXT NOT NULL); DELETE FROM check_candidates;');
      const records = this.readRecords(config.source);
      const byScenario = { margin: 0, inventory: 0, ads: 0 };
      let checked = 0, anomalies = 0, stale = false;
      // Stage in SQLite rather than retain every source record and finding in JS arrays.
      // No findings enter the durable ledger until the original lease is revalidated.
      const stage = this.db.query('INSERT INTO check_candidates VALUES(?,?)');
      this.db.transaction(() => { for (const record of records) {
        if (record.source !== config.source) continue;
        checked++;
        if (config.source === 'csv' && evidenceTimeIssue(record, this.clock())) stale = true;
        const scenario = 'kind' in record ? record.kind : 'margin'; byScenario[scenario]++;
        if (record.status === 'normal') continue;
        // Batch/import IDs can change when an unrelated row is corrected; unchanged business content must not re-alert.
        const key = createHash('sha256').update(JSON.stringify([this.workspaceId, scenario, record.source, record.row, record.ruleVersion, record.status, 'kind' in record ? record.metrics : record.calculation])).digest('hex');
        stage.run(key, JSON.stringify({ key, scenario, record } satisfies CheckFinding)); anomalies++;
      } }).deferred();
      const warnings = Object.entries(byScenario).filter(([, count]) => !count).map(([name]) => `${name === 'margin' ? '毛利' : name === 'inventory' ? '库存' : '广告'}没有该来源的可检查快照`);
      if (stale) warnings.push('存在导入或业务日期超过24小时历史容限、或时间异常的CSV快照；结果仅作历史检查，重新导入不代表业务数据更新。');
      // Findings and final result commit atomically; expired workers cannot overwrite a retried lease.
      this.db.transaction(() => {
        const current = this.db.query<{ json: string }, [string]>('SELECT json FROM check_runs WHERE id=?').get(claimed.id);
        const saved = current ? JSON.parse(current.json) as CheckRun : null;
        if (!saved || saved.status !== 'running' || saved.attempt !== claimed.attempt) throw new Error('巡检租约已失效，未保存过期结果');
        const added = this.db.query('INSERT OR IGNORE INTO check_findings SELECT key,?,json FROM check_candidates').run(claimed.id).changes;
        const findings = this.db.query<{ json: string }, []>('SELECT json FROM check_candidates ORDER BY rowid LIMIT 200').all().map(row => JSON.parse(row.json) as CheckFinding);
        const result: CheckResult = { checked, byScenario, anomalies, newFindings: added, repeatedFindings: anomalies - added, findings, truncated: anomalies > 200, warnings, observedAt: iso(this.clock()) };
        this.save({ ...claimed, status: 'succeeded', finishedAt: iso(this.clock()), result });
      }).immediate();
    } catch (error) {
      this.db.transaction(() => {
        const current = this.db.query<{ json: string }, [string]>('SELECT json FROM check_runs WHERE id=?').get(claimed.id);
        const saved = current ? JSON.parse(current.json) as CheckRun : null;
        if (saved?.status === 'running' && saved.attempt === claimed.attempt) this.save({ ...claimed, status: 'failed', finishedAt: iso(this.clock()), error: error instanceof Error ? error.message.slice(0, 1000) : '巡检失败' });
      }).immediate();
    } finally { this.db.exec('DELETE FROM check_candidates'); }
    return true;
  }
}
