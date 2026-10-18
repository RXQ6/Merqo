import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RetailStore } from '../packages/retail-domain/src/store';
import { FIELDS, DEMO_CSV } from '../packages/retail-domain/src/operations';
import { requestRetailWorker } from '../apps/electron/src/main/retail-worker';

if (process.argv.length > 2) throw new Error('No arguments accepted; fixed 100000-row / 30-request evaluation');
const out = resolve('artifacts/performance', new Date().toISOString().replace(/[:.]/g, '-')); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'merqo-performance-')); mkdirSync(join(dir, 'retail'));
const file = join(dir, 'retail/operations.sqlite');
const store = new RetailStore(file, 'Performance isolated synthetic');
const csvRows = [FIELDS.join(',')]; const sample = DEMO_CSV.split('\r\n')[1]!.split(',');
let expectedRevenue = 0n, expectedProfit = 0n, expectedKnown = 0;
for (let i = 0; i < 100000; i++) {
  const row = [...sample]; row[1] = `shop-${i % 20}`; row[3] = `SKU-${String(i).padStart(6, '0')}`; row[4] = '合成性能商品'; row[5] = '500ml';
  const missing = i % 7 === 0, coupon = i % 3 === 0 ? 0 : 2000;
  row[8] = String(coupon); row[12] = missing ? '' : '6000';
  if (!missing) { expectedKnown++; const revenue = BigInt(10000 - coupon - 1000); expectedRevenue += revenue * 40n; expectedProfit += (revenue - 6000n) * 40n; }
  csvRows.push(row.join(','));
}
const csv = csvRows.join('\n'), datasetHash = createHash('sha256').update(csv).digest('hex');
const timings: number[] = []; let report: Record<string, unknown> = {};
try {
  const start = performance.now(); store.import(csv, undefined, 'csv'); const importMs = performance.now() - start;
  const sourceHashes = Object.fromEntries(['operations','store','retail-query'].map(n => [n, createHash('sha256').update(readFileSync(`packages/retail-domain/src/${n}.ts`)).digest('hex')]));
  // Fresh worker per query: includes process launch, SQLite open, bounded response and JSON transport. OS cache is warm after import.
  for (let i = 0; i < 30; i++) {
    const before = performance.now();
    const result = await requestRetailWorker({ rootPath: dir, name: 'Performance isolated synthetic' }, 'perf-isolated', { op: 'snapshot', source: 'csv', limit: 30, offset: i % 3 === 0 ? 90000 : i * 30, status: i % 3 === 1 ? 'low_margin' : 'all' }, 'snapshot');
    timings.push(performance.now() - before);
    if (!result.ok || result.kind !== 'snapshot' || !result.data.pagination || result.data.records.length > 30) throw new Error('Unbounded or invalid production worker response');
    const s = result.data.pagination.summary;
    if (s.total !== 100000 || s.known !== expectedKnown || s.revenueMinor !== expectedRevenue.toString() || s.profitMinor !== expectedProfit.toString()) throw new Error('Scope totals do not match independent generated-data oracle');
  }
  const sorted = [...timings].sort((a,b) => a-b), p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  report = { evaluatedAt: new Date().toISOString(), passed: p95Ms <= 2000, rows: 100000, queries: 30, p95Ms, importMs, timings, datasetHash, sourceHashes, queryPlan: store.queryPlan(),
    expected: { known: expectedKnown, revenueMinor: expectedRevenue.toString(), profitMinor: expectedProfit.toString() },
    machine: { platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), bun: Bun.version },
    cache: 'OS/SQLite files warmed by import and projection build; fresh worker and SQLite connection per measured request; no model calls',
    scope: 'margin common scope totals, status and first/deep offset pages; not signal-query performance, renderer paint, cold disk, concurrent writes or model latency' };
  if (p95Ms > 2000) process.exitCode = 1;
} catch (error) { report = { passed: false, timings, datasetHash, error: error instanceof Error ? error.message : 'failed' }; process.exitCode = 1; }
finally { store.close(); rmSync(dir, { recursive: true, force: true }); writeFileSync(join(out, 'report.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify({ output: out, ...report })); }
