import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { ScheduledChecks } from './scheduled-checks';
import { RetailStore } from './store';
import { SignalStore } from './signal-store';
import { DEMO_CSV, RetailRequestSchema } from './operations';
import { INVENTORY_DEMO, ADS_DEMO } from './signals';
import type { SourceMetadataInput } from './source-metadata';
let dir: string, file: string, data: RetailStore, signals: SignalStore, checks: ScheduledChecks, now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merqo-checks-')); file = join(dir, 'checks.sqlite'); now = Date.parse('2026-10-17T02:03:00Z');
  data = new RetailStore(join(dir, 'data.sqlite')); data.import(DEMO_CSV, undefined, 'demo'); signals = new SignalStore(join(dir, 'signals.sqlite')); signals.demo();
  checks = new ScheduledChecks(file, 'a', () => [...data.snapshot().records, ...signals.snapshot().records], () => now);
});
afterEach(() => { checks.close(); data.close(); signals.close(); rmSync(dir, { recursive: true, force: true }); });
test('default is disabled, manual and scheduled share a unique slot without touching business state', () => {
  expect(checks.run('scheduled').runs).toHaveLength(0);
  const before = data.snapshot().records;
  const manual = checks.run('manual'); const run = manual.runs[0]!;
  expect(run.result!.checked).toBe(12); expect(run.result!.anomalies).toBe(8); expect(run.result!.newFindings).toBe(8);
  expect(checks.run('manual').lastAction).toEqual({ created: 0, reused: 1 });
  expect(data.snapshot().records).toEqual(before);
  checks.configure(1, { enabled: true, intervalMinutes: 60, source: 'demo' });
  const scheduled = checks.run('scheduled'); const current = scheduled.runs.find(r => r.config.revision === 2)!; expect(current.trigger).toBe('scheduled');
  expect(current.result!.newFindings).toBe(0); expect(current.result!.repeatedFindings).toBe(8);
  expect(checks.run('manual').runs).toHaveLength(2);
});
test('offline gap is visible, bounded manual catch-up reads current data and keeps slot/observation distinct', () => {
  checks.configure(1, { enabled: true, intervalMinutes: 15, source: 'demo' });
  now += 30 * 15 * 60000;
  const due = checks.view(); expect(due.pendingSlots).toHaveLength(24); expect(due.olderSlotsExcluded).toBe(7);
  const caught = checks.run('catchup'); expect(caught.lastAction!.created).toBe(6); expect(caught.pendingSlots).toHaveLength(18);
  expect(caught.runs.every(r => r.result!.observedAt === new Date(now).toISOString() && r.slot < r.result!.observedAt)).toBe(true);
  expect(caught.runs.reduce((n, r) => n + r.result!.newFindings, 0)).toBe(8);
});
test('missed slots are not automatically replayed at restart; same-slot dedup survives restart', () => {
  checks.configure(1, { enabled: true, intervalMinutes: 60, source: 'demo' }); checks.run('scheduled');
  checks.close(); now += 3 * 3600000;
  checks = new ScheduledChecks(file, 'a', () => data.snapshot().records, () => now);
  const result = checks.run('scheduled'); expect(result.runs).toHaveLength(2); expect(result.pendingSlots).toHaveLength(2);
  expect(checks.run('scheduled').lastAction!.created).toBe(0);
});
test('optimistic config versions, source separation and empty-data gaps are explicit', () => {
  checks.configure(1, { enabled: false, intervalMinutes: 15, source: 'csv' });
  expect(() => checks.configure(1, { enabled: true, intervalMinutes: 60, source: 'demo' })).toThrow('配置已变更');
  expect(checks.configure(2, { enabled: false, intervalMinutes: 15, source: 'csv' }).config.revision).toBe(2);
  const run = checks.run('manual').runs[0]!; expect(run.result!.checked).toBe(0); expect(run.result!.warnings).toHaveLength(3);
  expect(() => new ScheduledChecks(file, 'other', () => [])).toThrow('工作空间');
});
test('failure is durable, explicit retries preserve history and obey three-attempt budget', () => {
  checks.close(); checks = new ScheduledChecks(file, 'a', () => { throw new Error('模拟数据读取失败'); }, () => now);
  const failed = checks.run('manual').runs[0]!; expect(failed.status).toBe('failed');
  expect(checks.run('manual').lastAction!.created).toBe(0);
  expect(checks.retry(failed.id).runs[0]!.attempt).toBe(2);
  const third = checks.retry(failed.id).runs[0]!; expect(third.attempt).toBe(3); expect(third.history).toHaveLength(2); expect(third.history[0]!.error).toBe('模拟数据读取失败');
  expect(() => checks.retry(failed.id)).toThrow('三次');
});
test('lost worker lease becomes interrupted, late old result cannot override a new attempt', () => {
  checks.close();
  let recovered = false;
  checks = new ScheduledChecks(file, 'a', () => {
    if (!recovered) {
      recovered = true; now += 121000;
      const other = new ScheduledChecks(file, 'a', () => [], () => now);
      try { const stale = other.view().runs[0]!; expect(stale.status).toBe('interrupted'); other.retry(stale.id); } finally { other.close(); }
    }
    return data.snapshot().records;
  }, () => now);
  const result = checks.run('manual').runs[0]!;
  expect(result.attempt).toBe(2); expect(result.status).toBe('succeeded'); expect(result.result!.checked).toBe(0);
  expect(result.history[0]!.status).toBe('interrupted');
});
test('new snapshots create new findings while stable repeated snapshots do not', () => {
  const first = checks.run('manual').runs[0]!;
  data.import(DEMO_CSV.replace('桂花乌龙冷萃茶','修订名称'), undefined, 'demo'); now += 3600000;
  const next = checks.run('manual').runs[0]!;
  expect(next.result!.newFindings).toBe(1); expect(next.result!.repeatedFindings).toBe(7);
  expect(first.result!.findings[0]!.record).toBeDefined();
});

test.each(['margin', 'inventory', 'ads'] as const)('%s findings distinguish declared sources and deduplicate reimports after restart', scenario => {
  const csv = (scenario === 'margin' ? DEMO_CSV : scenario === 'inventory' ? INVENTORY_DEMO : ADS_DEMO).split('\n').slice(0, 2).join('\n');
  const metadata: SourceMetadataInput = { sourceId: 'export:source-a', sourceName: 'Source A', sourceObservedAt: '2026-10-15T09:00:00+08:00', coverageStartInclusive: '2026-09-01T00:00:00+08:00', completeThroughExclusive: '2026-10-15T00:00:00+08:00', completeness: 'complete', timezone: 'Asia/Shanghai' };
  const load = (sourceMetadata: SourceMetadataInput) => scenario === 'margin'
    ? data.import(csv, undefined, 'csv', false, sourceMetadata)
    : signals.import(scenario, csv, undefined, 'csv', false, sourceMetadata);
  checks.configure(1, { enabled: true, intervalMinutes: 60, source: 'csv' });
  load(metadata);
  const first = checks.run('scheduled').runs[0]!.result!;
  expect(first).toMatchObject({ checked: 1, anomalies: 1, newFindings: 1, repeatedFindings: 0 });

  const secondSource = { ...metadata, sourceId: 'export:source-b', sourceName: 'Source B' };
  load(secondSource); now += 3600000;
  const second = checks.run('scheduled').runs[0]!.result!;
  expect(second).toMatchObject({ checked: 1, anomalies: 1, newFindings: 1, repeatedFindings: 0 });
  expect(second.findings[0]!.key).not.toBe(first.findings[0]!.key);
  expect([...checks.findingsSince('2026-10-17T00:00:00Z')].map(f => f.finding.record.provenance!.sourceId).sort()).toEqual(['export:source-a', 'export:source-b']);

  checks.close();
  checks = new ScheduledChecks(file, 'a', () => [...data.snapshot().records, ...signals.snapshot().records], () => now);
  load({ ...secondSource, sourceName: 'Renamed source B', sourceObservedAt: '2026-10-16T09:00:00+08:00' }); now += 3600000;
  const repeated = checks.run('scheduled').runs[0]!.result!;
  expect(repeated).toMatchObject({ checked: 1, anomalies: 1, newFindings: 0, repeatedFindings: 1 });
  expect(repeated.findings[0]!.key).toBe(second.findings[0]!.key);
});

test.each([true, false])('legacy findings retain their keys and first-run links (declared source: %s)', declared => {
  const csv = DEMO_CSV.split('\n').slice(0, 2).join('\n');
  const metadata: SourceMetadataInput = { sourceId: 'export:source-a', sourceName: 'Source A', sourceObservedAt: '2026-10-15T09:00:00+08:00', coverageStartInclusive: '2026-09-01T00:00:00+08:00', completeThroughExclusive: '2026-10-15T00:00:00+08:00', completeness: 'complete', timezone: 'Asia/Shanghai' };
  data.import(csv, undefined, 'csv', false, declared ? metadata : undefined);
  checks.configure(1, { enabled: true, intervalMinutes: 60, source: 'csv' });
  const first = checks.run('scheduled').runs[0]!;
  const finding = first.result!.findings[0]!, record = finding.record;
  // Recreate the pre-source-scope persisted format, including its downstream key.
  const legacyKey = createHash('sha256').update(JSON.stringify(['a', finding.scenario, record.source, record.row, record.ruleVersion, record.status, 'kind' in record ? record.metrics : record.calculation])).digest('hex');
  first.result!.findings[0] = { ...finding, key: legacyKey };
  checks.close();
  const db = new Database(file);
  try {
    db.query('UPDATE check_findings SET key=?,json=? WHERE key=?').run(legacyKey, JSON.stringify(first.result!.findings[0]), finding.key);
    db.query('UPDATE check_runs SET json=? WHERE id=?').run(JSON.stringify(first), first.id);
  } finally { db.close(); }
  checks = new ScheduledChecks(file, 'a', () => data.snapshot().records, () => now);
  now += 3600000;
  const repeated = checks.run('scheduled').runs[0]!.result!;
  expect(repeated.newFindings).toBe(0);
  expect(repeated.findings[0]!.key).toBe(legacyKey);
  const saved = [...checks.findingsSince('2026-10-17T00:00:00Z')];
  expect(saved).toHaveLength(1);
  expect(saved[0]!.runId).toBe(first.id);

  data.import(csv, undefined, 'csv', false, { ...metadata, sourceId: 'export:source-b' }); now += 3600000;
  const changed = checks.run('scheduled').runs[0]!.result!;
  expect(changed.newFindings).toBe(1);
  expect(changed.findings[0]!.key).not.toBe(legacyKey);
});
test('concurrent workers claim one slot only', async () => {
  const module = join(import.meta.dir, 'scheduled-checks.ts');
  const script = `import {ScheduledChecks} from ${JSON.stringify(module)};const c=new ScheduledChecks(${JSON.stringify(file)},'a',()=>[],()=>${now});console.log(JSON.stringify(c.run('manual').lastAction));c.close();`;
  const children = [Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' }), Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' })];
  const output = await Promise.all(children.map(async p => { const text = await new Response(p.stdout).text(); expect(await p.exited).toBe(0); return JSON.parse(text) as { created: number }; }));
  expect(output.reduce((n, x) => n + x.created, 0)).toBe(1); expect(checks.view().runs).toHaveLength(1);
});
test('clock rollback and renderer attempts to control internal ticks, scopes or timestamps fail', () => {
  now -= 3600000; expect(() => checks.run('manual')).toThrow('系统时间');
  for (const request of [{ op: 'check_tick' }, { op: 'check_run', workspaceId: 'x' }, { op: 'check_catchup', now: '2099-01-01' }, { op: 'check_run', mode: 'model' }]) expect(RetailRequestSchema.safeParse(request).success).toBe(false);
});
test('CSV freshness remains historical and finding previews are bounded without hiding counts', () => {
  checks.close();
  const base = data.snapshot().records.find(r => r.status !== 'normal')!;
  checks = new ScheduledChecks(file, 'a', () => Array.from({ length: 205 }, (_, i) => ({ ...base, id: 'csv-' + i, row: { ...base.row, sku_id: 'csv-' + i }, source: 'csv' as const, importedAt: '2000-01-01T00:00:00Z' })), () => now);
  checks.configure(1, { enabled: false, intervalMinutes: 60, source: 'csv' });
  const result = checks.run('manual').runs[0]!.result!;
  expect(result.findings).toHaveLength(200); expect(result.anomalies).toBe(205); expect(result.newFindings).toBe(205); expect(result.truncated).toBe(true); expect(result.warnings.some(w => w.includes('24小时'))).toBe(true);
});
test('actual data worker records a corrupt source failure and can read the ledger afterwards', async () => {
  const source = join(dir, 'corrupt.sqlite'); writeFileSync(source, 'not a SQLite database');
  const worker = join(import.meta.dir, '../../../scripts/retailpilot-data-worker.ts');
  const request = async (op: string) => {
    const child = Bun.spawn([process.execPath, worker, source, 'test', 'a'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ op })); child.stdin.end();
    const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    return JSON.parse(output) as { ok: boolean; kind: string; data: { runs: Array<{ status: string; error: string }> } };
  };
  const run = await request('check_run'); expect(run.ok).toBe(true); expect(run.data.runs[0]!.status).toBe('failed'); expect(run.data.runs[0]!.error).toBeTruthy();
  const refreshed = await request('checks'); expect(refreshed.data.runs[0]!.error).toBe(run.data.runs[0]!.error);
});
test('unsupported future ledger versions are rejected without overwriting results', () => {
  checks.run('manual');
  const database = new Database(file); database.exec('PRAGMA user_version=2'); database.close();
  expect(() => new ScheduledChecks(file, 'a', () => [])).toThrow('数据库版本');
  expect(checks.view().runs).toHaveLength(1);
});

test('one-shot source failure discards staged findings and retry commits exactly once', () => {
  checks.close(); let fail = true;
  const base = data.snapshot().records.find(row => row.status !== 'normal')!;
  checks = new ScheduledChecks(file, 'a', function* () {
    yield base;
    if (fail) throw new Error('源游标中断');
    yield { ...base, row: { ...base.row, sku_id: 'stream-second' } };
  }, () => now);
  const failed = checks.run('manual').runs[0]!;
  expect(failed.status).toBe('failed');
  const db = new Database(file);
  try { expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM check_findings').get()!.n).toBe(0); } finally { db.close(); }
  fail = false;
  const retried = checks.retry(failed.id).runs[0]!;
  expect(retried.result).toMatchObject({ checked: 2, anomalies: 2, newFindings: 2 });
  now += 3600000;
  expect(checks.run('manual').runs[0]!.result).toMatchObject({ checked: 2, anomalies: 2, newFindings: 0, repeatedFindings: 2 });
});

test('staging a lazy source does not block lease recovery or publish the expired attempt', () => {
  checks.close(); let replaced=false;
  const base = data.snapshot().records[0]!;
  checks = new ScheduledChecks(file,'a',function* () {
    yield base;
    if(!replaced) {
      replaced=true; now+=121000;
      const other=new ScheduledChecks(file,'a',()=>[],()=>now);
      try {const run=other.view().runs[0]!; other.retry(run.id);} finally {other.close();}
    }
  },()=>now);
  const run=checks.run('manual').runs[0]!;
  expect(run.attempt).toBe(2); expect(run.status).toBe('succeeded'); expect(run.result!.checked).toBe(0);
});
