import { createHash } from 'node:crypto';
import type { BusinessEvidence } from './workbench-contract';
import type { BusinessTask } from './business-task-contract';
export const businessDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const evidenceHash = (e: BusinessEvidence) => 'hash' in e ? e.hash : e.snapshotHash;
export function businessScope(e: BusinessEvidence): BusinessTask['scope'] {
  const r = e.row;
  return { source: e.source, sourceId: e.provenance?.sourceId ?? null, shop: r.shop_id, channel: r.channel, sku: r.sku_id, spec: 'spec' in r ? r.spec : null, date: r.date, scenario: 'kind' in e ? e.kind : 'margin', warehouse: 'warehouse_id' in r ? r.warehouse_id : null, campaign: 'campaign_id' in r ? r.campaign_id : null };
}
export function businessEntityId(scope: BusinessTask['scope'], hash: string) {
  return businessDigest([scope.source, scope.sourceId ?? hash, scope.shop, scope.channel, scope.sku, scope.spec, scope.warehouse, scope.campaign]);
}
export const evidenceEntityId = (e: BusinessEvidence) => businessEntityId(businessScope(e), evidenceHash(e));
