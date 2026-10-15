import { RetailStore } from '../packages/retail-domain/src/store.ts';
import { RetailRequestSchema } from '../packages/retail-domain/src/operations.ts';
import { InvestigationStore } from '../packages/retail-domain/src/investigation-store.ts';
import type { InvestigationReport, Trace } from '../packages/retail-domain/src/investigations.ts';
import { z } from 'zod';
const file = process.argv[2];
if (!file) throw new Error('Missing trusted database path');
let store: RetailStore | undefined;
let investigations: InvestigationStore | undefined;
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  store = new RetailStore(file, process.argv[3] || '当前 Workspace');
  investigations = new InvestigationStore(file + '.investigations.sqlite');
  // Internal worker protocol is not exposed by the renderer IPC whitelist.
  const internal = z.strictObject({ op: z.literal('investigation_update'), id: z.string().uuid(), event: z.custom<Trace>().optional(), report: z.custom<InvestigationReport>().optional(), error: z.string().max(1000).optional(), model: z.string().max(200).optional() }).safeParse(input);
  if (internal.success) {
    const { id, event, report, error, model } = internal.data;
    console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [investigations.update(id, { ...(event ? { event } : {}), ...(report ? { report } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}) })] }));
  } else {
    const request = RetailRequestSchema.parse(input);
    if (request.op === 'investigations') console.log(JSON.stringify({ ok: true, kind: 'investigations', data: investigations.list(request.recordId) }));
    else if (request.op === 'investigate') {
      const evidence = store.snapshot().records.find(r => r.id === request.recordId);
      if (!evidence) throw new Error('快照不存在或已被新版替换，请刷新后重新选择');
      if (evidence.status === 'normal') throw new Error('请选择毛利预警或待补证记录');
      const result = investigations.create(evidence, request.mode, request.retry);
      console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [result.run], created: result.created }));
    } else console.log(JSON.stringify(store.request(request)));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '经营数据处理失败' }));
  process.exitCode = 1;
} finally { investigations?.close(); store?.close(); }
