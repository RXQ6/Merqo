/** A fixed, single-pass Reviewer test set, not an end-to-end Agent or 48-case benchmark. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import cases from '../fixtures/retail/margin-review-cases.json';
import { RetailStore } from '../packages/retail-domain/src/store';
import { DEMO_CSV } from '../packages/retail-domain/src/operations';
import { runReadonlyReview } from '../packages/retail-domain/src/investigations';
import { marginReviewInput, MARGIN_REVIEW_SYSTEM } from '../packages/retail-domain/src/margin-review-evaluation';
import type { MarginReviewCase } from '../packages/retail-domain/src/margin-review-evaluation';
if (process.argv.slice(2).join(' ') !== '--live') throw new Error('Requires --live; makes up to 20 configured-provider calls using synthetic evidence only.');
process.env.CRAFT_CONFIG_DIR = resolve('.runtime/config');
process.env.CRAFT_RESOURCES_BASE = resolve('apps/electron');
const { createInvestigationModel } = await import('../apps/electron/src/main/retail-investigation');
const dir = mkdtempSync(join(tmpdir(), 'merqo-review-eval-'));
const store = new RetailStore(join(dir, 'data.sqlite'));
const outputDir = resolve('artifacts/margin-review', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outputDir, { recursive: true });
const output = join(outputDir, 'report.json');
const results: unknown[] = []; let failures = 0; let totalCalls = 0;
mkdirSync('artifacts', { recursive: true });
try {
  store.import(DEMO_CSV, undefined, 'demo');
  const base = store.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!;
  for (const sample of cases as MarginReviewCase[]) {
    const context = marginReviewInput(base, sample); const events: unknown[] = [];
    const deadline = Date.now() + 90000; let calls = 0;
    let result: Record<string, unknown>; let closeAdapter: (() => void) | undefined;
    try {
      const adapter = await createInvestigationModel(dir, new Date(deadline).toISOString());
      closeAdapter = adapter.close;
      const review = await runReadonlyReview(async (system, prompt) => { calls++; totalCalls++; return adapter.model(system, prompt); }, MARGIN_REVIEW_SYSTEM, context,
        () => { if (Date.now() >= deadline) throw new Error('Reviewer case deadline exceeded'); }, async event => { events.push(event); }, sample.id);
      const matched = review.verdict === sample.expected; if (!matched) failures++;
      result = { id: sample.id, expected: sample.expected, matched, calls, model: adapter.name, config: adapter.config, systemHash: createHash('sha256').update(MARGIN_REVIEW_SYSTEM).digest('hex'), review, context, events };
    } catch (error) { failures++; result = { id: sample.id, expected: sample.expected, matched: false, calls, error: error instanceof Error ? error.message : 'Evaluation failed', context, events }; }
    finally { closeAdapter?.(); }
    results.push(result);
    writeFileSync(output, JSON.stringify({ evaluatedAt: new Date().toISOString(), syntheticOnly: true, singlePass: true, scope: 'reviewer_only', system: MARGIN_REVIEW_SYSTEM, dataset: cases, totalCalls, failures, results }, null, 2));
    console.log(JSON.stringify({ id: result.id, matched: result.matched, calls, verdict: (result.review as { verdict?: string } | undefined)?.verdict, error: result.error }));
  }
  if (failures) process.exitCode = 1;
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); console.log(JSON.stringify({ output, totalCalls, failures })); }
