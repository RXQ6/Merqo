/** Opt-in live model evaluation. Uses existing encrypted credentials; submits synthetic demo records only. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RetailStore } from '../packages/retail-domain/src/store';
import { SignalStore } from '../packages/retail-domain/src/signal-store';
import { InvestigationStore } from '../packages/retail-domain/src/investigation-store';
import type { AnyInvestigation, Trace } from '../packages/retail-domain/src/investigations';
import { runInvestigation, isSignalInvestigation } from '../packages/retail-domain/src/investigations';
import { runSignalInvestigation } from '../packages/retail-domain/src/signal-investigations';
import { connectRetailMcp } from '../apps/electron/src/main/retail-mcp';
import { DEMO_CSV } from '../packages/retail-domain/src/operations';
const scenarioFlag=process.argv.indexOf('--scenario');if(scenarioFlag>=0&&!['margin','inventory','ads'].includes(process.argv[scenarioFlag+1]??''))throw new Error('Invalid scenario');
if (!process.argv.includes('--live')) throw new Error('Real model calls require explicit --live (uses configured provider quota).');
process.env.CRAFT_CONFIG_DIR = resolve('.runtime/config');
process.env.CRAFT_RESOURCES_BASE = resolve('apps/electron');
const { createInvestigationModel } = await import('../apps/electron/src/main/retail-investigation');
const dir = mkdtempSync(join(tmpdir(), 'merqo-live-')); mkdirSync(join(dir,'retail')); const file=join(dir,'retail/operations.sqlite'); const data = new RetailStore(file); const signals = new SignalStore(file+'.signals.sqlite'); const runs = new InvestigationStore(file+'.investigations.sqlite');
const results: Array<{ scenario: 'margin' | 'inventory' | 'ads'; state: AnyInvestigation['state']; model: string | null; modelCalls: number; elapsedMs: number; error: string | null; trace: Trace[]; report: AnyInvestigation['report'] }> = []; mkdirSync('artifacts/m2', { recursive: true });
try {
  data.import(DEMO_CSV, undefined, 'demo'); signals.demo();
  for (const scenario of ['margin', 'inventory', 'ads'] as const) {
    const selected = process.argv.indexOf('--scenario'); if (selected >= 0 && process.argv[selected + 1] !== scenario) continue;
    const run = scenario === 'margin' ? runs.create(data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!, 'model').run : runs.createSignal(signals.snapshot().records.find(r => r.kind === scenario && r.row.sku_id === 'TEA-500')!, 'model').run;
    const start = Date.now(); let modelCalls = 0; console.log(`Starting synthetic ${scenario} model evaluation`);
    try {
      const adapter = await createInvestigationModel(dir, run.deadlineAt); runs.update(run.id, { model: adapter.name });
      const responses: string[] = [];
      const model = async (system: string, prompt: string) => { modelCalls++; const response = await adapter.model(system, prompt); responses.push(response); if (process.argv.includes('--diagnostics')) writeFileSync(`artifacts/m2/live-${scenario}-responses.json`, JSON.stringify(responses, null, 2)); return response; };
      const emit = async (event: Trace) => { runs.update(run.id, { event }); };
      const mcp = await connectRetailMcp(run,dir);
      try { const report = isSignalInvestigation(run) ? await runSignalInvestigation(run, model, emit, mcp.skill, mcp.tool) : await runInvestigation(run, model, emit, mcp.skill, mcp.tool); runs.update(run.id, { report }); } finally { await mcp.close(); }
    } catch (error) { runs.update(run.id, { error: error instanceof Error ? error.message : 'Evaluation failed' }); }
    const result = runs.listAll().find(r => r.id === run.id)!;
    results.push({ scenario, state: result.state, model: result.model, modelCalls, elapsedMs: Date.now() - start, error: result.error, trace: result.trace, report: result.report });
    writeFileSync('artifacts/m2/live-model-check.json', JSON.stringify({ evaluatedAt: new Date().toISOString(), syntheticOnly: true, results }, null, 2));
    console.log(JSON.stringify({ scenario, state: result.state, modelCalls, traceEvents: result.trace.length, error: result.error, reviewer: result.report?.reviewer.verdict }));
  }
  if (results.some(r => !r.report || r.state === 'failed')) process.exitCode = 1;
} finally { data.close(); signals.close(); runs.close(); rmSync(dir, { recursive: true, force: true }); }
