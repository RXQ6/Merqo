/** M0 contracts only: no business approval or execution engine is implemented yet. */
import { z } from 'zod';

export const EntityId = z.string().trim().min(1).max(160).brand<'EntityId'>();
export const Timestamp = z.iso.datetime({ offset: true });
export const MinorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ScopeSchema = z.strictObject({
  workspace_id: EntityId,
  shop_id: EntityId,
  channel: z.string().trim().min(1),
});
export const PeriodSchema = z.strictObject({
  start: Timestamp,
  end: Timestamp,
  timezone: z.literal('Asia/Shanghai'),
}).refine(value => Date.parse(value.start) < Date.parse(value.end), 'Period must be [start, end) with start < end');

export const SkuSchema = z.strictObject({
  ...ScopeSchema.shape,
  sku_id: EntityId,
  product_id: EntityId,
  source_sku_id: EntityId,
  spec: z.record(z.string(), z.string()),
  currency: z.literal('CNY'),
  cost_minor: MinorUnits.nullable(),
});
export const SalesSchema = z.strictObject({
  ...ScopeSchema.shape,
  sku_id: EntityId,
  period: PeriodSchema,
  paid_qty: z.number().int().nonnegative(),
  refunded_qty: z.number().int().nonnegative(),
  merchant_revenue_minor: MinorUnits,
  currency: z.literal('CNY'),
});
export const InventorySchema = z.strictObject({
  ...ScopeSchema.shape,
  sku_id: EntityId,
  warehouse_id: EntityId,
  on_hand: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  inbound_qty: z.number().int().nonnegative(),
  observed_at: Timestamp,
}).refine(value => value.reserved <= value.on_hand, 'Reserved quantity exceeds on-hand stock');
export const PromotionSchema = z.strictObject({
  ...ScopeSchema.shape,
  promotion_id: EntityId,
  sku_ids: z.array(EntityId).min(1),
  discount_minor: MinorUnits,
  funding_party: z.enum(['merchant', 'platform', 'shared', 'unknown']),
  stack_rule: z.enum(['exclusive', 'stackable', 'unknown']),
  period: PeriodSchema,
});
export const EvidenceSchema = z.strictObject({
  ...ScopeSchema.shape,
  evidence_id: EntityId,
  source_id: EntityId,
  sku_ids: z.array(EntityId).min(1),
  period: PeriodSchema,
  observed_at: Timestamp,
  retrieved_at: Timestamp,
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  quality_flags: z.array(z.enum(['stale', 'partial', 'ambiguous_sku', 'unknown_cost', 'unknown_funding'])),
});

const ActionBase = { ...ScopeSchema.shape, expected_version: z.string().min(1) };
export const ActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...ActionBase, type: z.literal('change_price'), sku_id: EntityId, price_minor: MinorUnits.positive() }),
  z.strictObject({ ...ActionBase, type: z.literal('change_budget'), campaign_id: EntityId, daily_budget_minor: MinorUnits }),
  z.strictObject({ ...ActionBase, type: z.literal('request_replenishment'), sku_id: EntityId, warehouse_id: EntityId, quantity: z.number().int().positive() }),
]);
export const DecisionSchema = z.strictObject({
  ...ScopeSchema.shape,
  decision_id: EntityId,
  version: z.number().int().positive(),
  evidence_ids: z.array(EntityId).min(1),
  policy_version: z.string().min(1),
  action: ActionSchema,
}).refine(value => value.workspace_id === value.action.workspace_id && value.shop_id === value.action.shop_id && value.channel === value.action.channel, 'Action scope differs from decision');
export const ApprovalSchema = z.strictObject({
  ...ScopeSchema.shape,
  approval_id: EntityId,
  decision_id: EntityId,
  decision_version: z.number().int().positive(),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  policy_version: z.string().min(1),
  expires_at: Timestamp,
  resolution: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('PENDING') }),
    z.strictObject({ status: z.literal('APPROVED'), approver_id: EntityId, approved_at: Timestamp }),
    z.strictObject({ status: z.literal('REJECTED'), approver_id: EntityId, reason: z.string().min(1) }),
    z.strictObject({ status: z.literal('EXPIRED') }),
    z.strictObject({ status: z.literal('SUPERSEDED') }),
  ]),
});
export const ExecutionSchema = z.strictObject({
  ...ScopeSchema.shape,
  execution_id: EntityId,
  approval_id: EntityId,
  idempotency_key: z.string().min(1),
  status: z.enum(['QUEUED', 'EXECUTING', 'UNKNOWN', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'MANUAL_REVIEW']),
  external_request_id: z.string().nullable(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
});

export type Scope = z.infer<typeof ScopeSchema>;
export type Sku = z.infer<typeof SkuSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Execution = z.infer<typeof ExecutionSchema>;
