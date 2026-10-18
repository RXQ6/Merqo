/** Opt-in M5: exactly five real-model investigations per scenario, through production readonly MCP. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RetailStore } from '../packages/retail-domain/src/store';
import { SignalStore } from '../packages/retail-domain/src/signal-store';
import { InvestigationStore } from '../packages/retail-domain/src/investigation-store';
import { DecisionStore } from '../packages/retail-domain/src/decisions';
import { DEMO_CSV } from '../packages/retail-domain/src/operations';
import { INVENTORY_DEMO, ADS_DEMO } from '../packages/retail-domain/src/signals';
import { runInvestigation, isSignalInvestigation } from '../packages/retail-domain/src/investigations';
import type { AnyInvestigation, ModelPort, Trace } from '../packages/retail-domain/src/investigations';
import { runSignalInvestigation } from '../packages/retail-domain/src/signal-investigations';
import { LIVE_CONTRACT, liveHash, inspectLiveResponse, assessLiveRun, summarizeLiveRuns } from '../packages/retail-domain/src/live-evaluation';
import type { LiveScenario, LiveRunScore } from '../packages/retail-domain/src/live-evaluation';
import { connectRetailMcp } from '../apps/electron/src/main/retail-mcp';
import type { InferenceTelemetry } from '../apps/electron/src/main/retail-inference-telemetry';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--live', '--preflight'].includes(args[0]!)) throw new Error('Usage: bun scripts/merqo-live-eval.ts --preflight | --live');
process.env.CRAFT_CONFIG_DIR = resolve('.runtime/config');
process.env.CRAFT_RESOURCES_BASE = resolve('apps/electron');
const { createInvestigationModel } = await import('../apps/electron/src/main/retail-investigation');
const probe = await createInvestigationModel(resolve('.runtime'), new Date(Date.now() + 300000).toISOString());
if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(probe.config.endpointOrigin).hostname)) throw new Error('Live evaluation rejects a local protocol fixture endpoint');
console.log(JSON.stringify({ preflight: 'ready', config: probe.config, rounds: 15, maximumRequests: 210, syntheticOnly: true }));
probe.close();
if (args[0] === '--preflight') process.exit(0);

const out = resolve('artifacts/live-eval', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8));
mkdirSync(out, { recursive: true });
const configHash = liveHash(probe.config);
const codeFiles = ['operations', 'signals', 'offers', 'readonly-tools', 'store', 'retail-query', 'signal-store', 'investigation-store', 'investigations', 'signal-investigations', 'margin-numeric', 'margin-evidence', 'ads-numeric', 'live-evaluation'].map(name => `packages/retail-domain/src/${name}.ts`).concat(['packages/shared/src/agent/base-agent.ts', 'packages/shared/src/agent/backend/types.ts', 'packages/shared/src/agent/backend/factory.ts', 'packages/shared/src/agent/backend/isolated-completion.ts', 'packages/shared/src/agent/backend/isolated-telemetry.ts', 'apps/electron/src/main/retail-investigation.ts', 'apps/electron/src/main/retail-inference-telemetry.ts', 'apps/electron/src/main/retail-mcp.ts', 'scripts/merqo-retail-mcp.ts', 'scripts/merqo-live-eval.ts', ...LIVE_CONTRACT.scenarios.map(s => `packages/retail-domain/skills/${s}/SKILL.md`)]);
const codeHashes = Object.fromEntries(codeFiles.map(file => [file, liveHash(readFileSync(file, 'utf8'))]));
const dataset = { contract: LIVE_CONTRACT, csv: { margin: DEMO_CSV, inventory: INVENTORY_DEMO, ads: ADS_DEMO } };
writeFileSync(join(out, 'dataset.json'), JSON.stringify(dataset, null, 2));
const temp = mkdtempSync(join(tmpdir(), 'merqo-m5-live-')); mkdirSync(join(temp, 'retail'));
const file = join(temp, 'retail/operations.sqlite');
const data = new RetailStore(file), signals = new SignalStore(file + '.signals.sqlite');
const runs = new InvestigationStore(file + '.investigations.sqlite', false, 'm5-live');
const decisions = new DecisionStore(file, 'm5-live', () => [...data.snapshot().records, ...signals.snapshot().records]);
type Call = { index: number; stage: 'investigate' | 'review'; systemHash: string; promptHash: string; responseHash: string | null; response: string | null; telemetry: InferenceTelemetry | null; reviewDraft?: unknown };
type Result = { scenario: LiveScenario; repetition: number; run: AnyInvestigation; calls: Call[]; elapsedMs: number; safetyViolations: string[]; score: LiveRunScore };
const results: Result[] = []; const systems: Record<string, string> = {}; const startedAt = new Date().toISOString();
function persist() {
  const summary = summarizeLiveRuns(results);
  const telemetry = results.flatMap(r => r.calls.map(c => c.telemetry).filter((v): v is InferenceTelemetry => v !== null));
  const totalCalls = results.reduce((n, r) => n + r.calls.length, 0);
  const measuredAll = totalCalls > 0 && telemetry.length === totalCalls;
  const report = { version: LIVE_CONTRACT.version, startedAt, updatedAt: new Date().toISOString(), syntheticOnly: true, config: probe.config, configHash,
    datasetHash: liveHash(dataset), codeHashes, systems, summary, businessReleaseReady: false,
    limitations: ['One fixed input repeated five times per scenario; not the full 48-case model benchmark', 'Evidence semantics use existing model Reviewer; deterministic checks cover frozen data, references, scenarios, ads numerical observations and disclosure consistency; inventory narrative numbers are not fully audited', 'No business approvals/executions; no real outcome or production identity proof', 'Missing provider token counters stay null; no currency cost estimate', 'API model sampling defaults are retained; repetitions are not independent evidence of production accuracy'],
    usage: { calls: totalCalls, meteredCalls: telemetry.filter(t => t.usage !== null).length,
      inputTokens: measuredAll && telemetry.every(t => t.usage?.inputTokens != null) ? telemetry.reduce((n, t) => n + t.usage!.inputTokens!, 0) : null,
      outputTokens: measuredAll && telemetry.every(t => t.usage?.outputTokens != null) ? telemetry.reduce((n, t) => n + t.usage!.outputTokens!, 0) : null }, results };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  const md = ['# M5 三场景真实模型评测', '', `开始：${startedAt}；更新：${report.updatedAt}`, '',
    `模型：${probe.name}；固定输入 SHA-256：${report.datasetHash}；配置 SHA-256：${configHash}`, '',
    `完成 ${summary.total}/15；通过 ${summary.passed}；失败 ${summary.failed}；禁止动作事件 ${summary.safetyViolations}；本项门禁 ${summary.passedGate ? '通过' : '未通过/尚未完成'}。完整业务发布门禁仍未通过。`, '',
    '| 场景 | 次数 | 通过 | 失败 | 至少4/5且无越权 |', '| --- | ---: | ---: | ---: | --- |',
    ...summary.scenarios.map(s => `| ${s.scenario} | ${s.total} | ${s.passed} | ${s.failed} | ${s.passedGate} |`), '',
    '| 场景/轮次 | 通过 | 调用 | Reviewer | 失败检查 |', '| --- | --- | ---: | --- | --- |',
    ...results.map(r => `| ${r.scenario}/${r.repetition} | ${r.score.passed} | ${r.calls.length} | ${r.run.report?.reviewer.verdict ?? '未完成'} | ${r.score.failures.join(', ')} |`), '',
    `已完成轮次的调用 ${report.usage.calls}；provider token input=${report.usage.inputTokens ?? '未知'}，output=${report.usage.outputTokens ?? '未知'}。`, '',
    ...report.limitations.map(x => '- ' + x), '', '每次输出、调用摘要、模型实际用量、完整冻结快照/Trace和评分细目见 report.json。所有15次保留，不选择性删除失败；应用内部格式纠正计入同轮调用。', ''].join('\n');
  writeFileSync(join(out, 'report.md'), md);
}
try {
  data.import(DEMO_CSV, undefined, 'demo'); signals.import('inventory', INVENTORY_DEMO, undefined, 'demo'); signals.import('ads', ADS_DEMO, undefined, 'demo');
  const baseline = liveHash([data.snapshot(), signals.snapshot()]);
  for (const scenario of LIVE_CONTRACT.scenarios) for (let repetition = 1; repetition <= 5; repetition++) {
    if (codeFiles.some(file => liveHash(readFileSync(file, 'utf8')) !== codeHashes[file])) throw new Error('评测期间源码发生变化，拒绝混合版本');
    const run = scenario === 'margin' ? runs.create(data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!, 'model', true).run
      : runs.createSignal(signals.snapshot().records.find(r => r.kind === scenario && r.row.sku_id === 'TEA-500')!, 'model', true).run;
    const start = Date.now(), calls: Call[] = [], safetyViolations: string[] = []; let reviewDraft: unknown; let closeAdapter: (() => void) | undefined;
    const checkpoint = () => writeFileSync(join(out, `${scenario}-${repetition}.in-progress.json`), JSON.stringify({ scenario, repetition, run: runs.get(run.id), calls, safetyViolations }, null, 2));
    checkpoint();
    console.log(JSON.stringify({ starting: `${scenario}/${repetition}`, runId: run.id }));
    try {
      let lastTelemetry: InferenceTelemetry | null = null;
      const adapter = await createInvestigationModel(temp, run.deadlineAt, event => { lastTelemetry = event; });
      closeAdapter = adapter.close;
      if (liveHash(adapter.config) !== configHash) throw new Error('评测期间模型配置发生变化，拒绝混合配置');
      runs.update(run.id, { model: adapter.name });
      const model: ModelPort = async (system, prompt) => {
        if (calls.length >= 14) throw new Error('评测模型调用预算耗尽');
        const stage = system.includes('串行只读 Reviewer') ? 'review' : 'investigate'; const systemHash = liveHash(system); systems[systemHash] = system;
        if (stage === 'review') reviewDraft = JSON.parse(prompt).context.draft;
        const call: Call = { index: calls.length + 1, stage, systemHash, promptHash: liveHash(prompt), responseHash: null, response: null, telemetry: null, ...(stage === 'review' ? { reviewDraft } : {}) };
        calls.push(call); lastTelemetry = null;
        checkpoint();
        try { const response = await adapter.model(system, prompt); call.response = response; call.responseHash = liveHash(response); safetyViolations.push(...inspectLiveResponse(response, scenario)); return response; }
        finally { call.telemetry = lastTelemetry; if ((lastTelemetry as InferenceTelemetry | null)?.nativeToolRequests) safetyViolations.push('模型返回原生工具请求，未执行'); checkpoint(); }
      };
      const emit = async (event: Trace) => { runs.update(run.id, { event }); checkpoint(); };
      const mcp = await connectRetailMcp(run, temp);
      try { const report = isSignalInvestigation(run) ? await runSignalInvestigation(run, model, emit, mcp.skill, mcp.tool) : await runInvestigation(run, model, emit, mcp.skill, mcp.tool); runs.update(run.id, { report }); }
      finally { await mcp.close(); }
    } catch (error) {
      const message = error instanceof Error && /HTTP \d+/.test(error.message) ? error.message : error instanceof Error && /模型|契约|预算|证据|配置|MCP|场景|方案|引用/.test(error.message) ? error.message.slice(0, 1000) : '评测运行失败；网络或运行时异常，未记录原始地址/凭据';
      runs.update(run.id, { error: message });
    } finally { closeAdapter?.(); }
    if (liveHash([data.snapshot(), signals.snapshot()]) !== baseline || decisions.approvals().length || decisions.executions().length) safetyViolations.push('只读评测产生业务状态变化');
    const stored = runs.get(run.id); const elapsedMs = Date.now() - start;
    const score = assessLiveRun(stored, calls.length, elapsedMs, safetyViolations, reviewDraft);
    score.checks.allRequestsMeasured = calls.every(c => c.telemetry?.status === 'succeeded');
    if (!score.checks.allRequestsMeasured) { score.failures.push('allRequestsMeasured'); score.passed = false; }
    const result = { scenario, repetition, run: stored, calls, elapsedMs, safetyViolations, score }; results.push(result);
    writeFileSync(join(out, `${scenario}-${repetition}.json`), JSON.stringify(result, null, 2)); persist();
    writeFileSync(join(out, `${scenario}-${repetition}.in-progress.json`), JSON.stringify({ completed: true, finalFile: `${scenario}-${repetition}.json`, runId: run.id }));
    console.log(JSON.stringify({ scenario, repetition, passed: score.passed, calls: calls.length, reviewer: stored.report?.reviewer.verdict, failures: score.failures, safetyViolations: safetyViolations.length, output: out }));
    if (safetyViolations.length) throw new Error('禁止动作事件已使门禁失败；保留证据并停止额外模型调用');
  }
  process.exitCode = summarizeLiveRuns(results).passedGate ? 0 : 1;
} finally { persist(); decisions.close(); runs.close(); signals.close(); data.close(); rmSync(temp, { recursive: true, force: true }); console.log(JSON.stringify({ output: out, summary: summarizeLiveRuns(results) })); }
