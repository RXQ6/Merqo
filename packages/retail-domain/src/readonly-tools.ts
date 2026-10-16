import { InvestigationStore } from './investigation-store';
import { RetailStore } from './store';
import { SignalStore } from './signal-store';
import { readTool } from './investigations';
import { readSignalTool, SIGNAL_TOOLS } from './signal-investigations';
import type { EvidenceRecord } from './operations';
import type { SignalRecord } from './signals';
export type ReadonlyScope = { scenario: 'margin' | 'inventory' | 'ads'; evidence: EvidenceRecord | SignalRecord };
export const MARGIN_TOOLS = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'] as const;
/** The operator chooses one existing record at launch; clients cannot supply paths or scope arguments. */
export function loadReadonlyScope(workspace: string, scenario: ReadonlyScope['scenario'], id: string): ReadonlyScope {
  if (scenario === 'margin') {
    const store = new RetailStore(workspace + '/retail/operations.sqlite', 'MCP 只读空间', true);
    try { const evidence = store.snapshot().records.find(r => r.id === id); if (!evidence) throw new Error('范围内无此记录'); return { scenario, evidence }; }
    finally { store.close(); }
  }
  const store = new SignalStore(workspace + '/retail/operations.sqlite.signals.sqlite', true);
  try { const evidence = store.snapshot().records.find(r => r.id === id && r.kind === scenario); if (!evidence) throw new Error('范围内无此场景记录'); return { scenario, evidence }; }
  finally { store.close(); }
}
export function scopedToolNames(scope: ReadonlyScope): readonly string[] { return scope.scenario === 'margin' ? MARGIN_TOOLS : SIGNAL_TOOLS[scope.scenario]; }
export function callReadonlyTool(scope: ReadonlyScope, name: string): unknown {
  if (!scopedToolNames(scope).includes(name)) throw new Error('工具不在冻结范围白名单');
  const data = scope.scenario === 'margin' ? readTool(scope.evidence as EvidenceRecord, name as typeof MARGIN_TOOLS[number]) : readSignalTool(scope.evidence as SignalRecord, name);
  return { data, evidenceId: `${scope.evidence.id}:${name}`, snapshotHash: 'hash' in scope.evidence ? scope.evidence.hash : scope.evidence.snapshotHash, ruleVersion: scope.evidence.ruleVersion, batchId: scope.evidence.batchId, observedAt: scope.evidence.row.date, retrievedAt: new Date().toISOString(), scope: { scenario: scope.scenario, shop: scope.evidence.row.shop_id, channel: scope.evidence.row.channel, sku: scope.evidence.row.sku_id, date: scope.evidence.row.date, warehouse: 'warehouse_id' in scope.evidence.row ? scope.evidence.row.warehouse_id : null, campaign: 'campaign_id' in scope.evidence.row ? scope.evidence.row.campaign_id : null }, partial: true };
}

/** Investigation ID is provided by the trusted desktop host; later corrections do not replace frozen evidence. */
export function loadReadonlyRunScope(workspace: string, runId: string): ReadonlyScope {
  const store = new InvestigationStore(workspace + '/retail/operations.sqlite.investigations.sqlite', true);
  try { const run = store.get(runId); return { scenario: run.scenario ?? 'margin', evidence: run.evidence }; }
  finally { store.close(); }
}
