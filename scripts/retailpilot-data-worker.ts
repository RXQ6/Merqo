import { RetailStore } from '../packages/retail-domain/src/store.ts';
import { RetailRequestSchema } from '../packages/retail-domain/src/operations.ts';
import { InvestigationStore } from '../packages/retail-domain/src/investigation-store.ts';
import { SignalStore } from '../packages/retail-domain/src/signal-store.ts';
import { previewSignals } from '../packages/retail-domain/src/signals.ts';
import type { InvestigationReport, Trace } from '../packages/retail-domain/src/investigations.ts';
import { z } from 'zod';
// Concurrent readers may initialize a new SQLite WAL/schema at the same time.
// Retry only opening/initializing stores, never replay a partially committed command.
function openStore<T>(create: () => T): T {
  const deadline = Date.now() + 5000;
  while (true) {
    try { return create(); }
    catch (error) {
      if (!(error instanceof Error) || !/database is locked|SQLITE_BUSY/i.test(error.message) || Date.now() >= deadline) throw error;
      Bun.sleepSync(25);
    }
  }
}
const file = process.argv[2];
if (!file) throw new Error('Missing trusted database path');
let store: RetailStore | undefined;
let investigations: InvestigationStore | undefined;
let signals: SignalStore | undefined;
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  store = openStore(() => new RetailStore(file, process.argv[3] || '当前 Workspace'));
  investigations = openStore(() => new InvestigationStore(file + '.investigations.sqlite'));
  // Internal worker protocol is not exposed by the renderer IPC whitelist.
  const internal = z.strictObject({ op: z.literal('investigation_update'), id: z.string().uuid(), event: z.custom<Trace>().optional(), report: z.custom<InvestigationReport>().optional(), error: z.string().max(1000).optional(), model: z.string().max(200).optional() }).safeParse(input);
  if (internal.success) {
    const { id, event, report, error, model } = internal.data;
    console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [investigations.update(id, { ...(event ? { event } : {}), ...(report ? { report } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}) })] }));
  } else {
    const request = RetailRequestSchema.parse(input);
    if (request.op === 'signals' || request.op === 'signals_demo' || request.op === 'signals_preview' || request.op === 'signals_import') {
      signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
      if (request.op === 'signals_preview') console.log(JSON.stringify({ ok: true, kind: 'signals_preview', data: previewSignals(request.kind, request.csv, request.mapping) }));
      else if (request.op === 'signals_import') { const result = signals.import(request.kind, request.csv, request.mapping, 'csv'); console.log(JSON.stringify({ ok: true, kind: 'signals', data: result.data, notice: result.notice })); }
      else console.log(JSON.stringify({ ok: true, kind: 'signals', data: request.op === 'signals_demo' ? signals.demo() : signals.snapshot() }));
    }
    else if (request.op === 'investigations') console.log(JSON.stringify({ ok: true, kind: 'investigations', data: investigations.list(request.recordId) }));
    else if (request.op === 'investigate') {
      const evidence = store.snapshot().records.find(r => r.id === request.recordId);
      if (!evidence) throw new Error('快照不存在或已被新版替换，请刷新后重新选择');
      if (evidence.status === 'normal') throw new Error('请选择毛利预警或待补证记录');
      const result = investigations.create(evidence, request.mode, request.retry);
      console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [result.run], created: result.created }));
    } else {
      const reply = store.request(request);
      if (reply.ok && reply.kind === 'snapshot') { signals = openStore(() => new SignalStore(file + '.signals.sqlite')); console.log(JSON.stringify({ ...reply, signals: request.op === 'demo' ? signals.demo() : signals.snapshot() })); }
      else console.log(JSON.stringify(reply));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '经营数据处理失败' }));
  process.exitCode = 1;
} finally { signals?.close(); investigations?.close(); store?.close(); }
