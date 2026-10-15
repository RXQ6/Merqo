import { describe, expect, test } from 'bun:test';
import { ActionSchema, ApprovalSchema, DecisionSchema, InventorySchema, MinorUnits, PeriodSchema } from './index.ts';

const scope = { workspace_id: 'demo', shop_id: 'shop-a', channel: 'retail' };
const period = { start: '2026-10-01T00:00:00+08:00', end: '2026-10-02T00:00:00+08:00', timezone: 'Asia/Shanghai' };

describe('business boundary contracts', () => {
  test('rejects fractional, negative and unsafe money', () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(MinorUnits.safeParse(value).success).toBe(false);
  });
  test('requires a forward, timezone-qualified business window', () => {
    expect(PeriodSchema.safeParse(period).success).toBe(true);
    expect(PeriodSchema.safeParse({ ...period, end: period.start }).success).toBe(false);
    expect(PeriodSchema.safeParse({ ...period, start: '2026-10-01' }).success).toBe(false);
  });
  test('does not accept reserved stock greater than physical stock', () => {
    expect(InventorySchema.safeParse({ ...scope, sku_id: 'a', warehouse_id: 'wh', on_hand: 1, reserved: 2, inbound_qty: 0, observed_at: period.start }).success).toBe(false);
  });
  test('rejects cross-shop actions and unrecognized action types', () => {
    const action = { ...scope, type: 'change_price', sku_id: 'a', expected_version: 'v1', price_minor: 9000 };
    const decision = { ...scope, decision_id: 'd', version: 1, evidence_ids: ['e'], policy_version: 'p1', action };
    expect(DecisionSchema.safeParse(decision).success).toBe(true);
    expect(DecisionSchema.safeParse({ ...decision, action: { ...action, shop_id: 'shop-b' } }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...action, type: 'delete_sku' }).success).toBe(false);
  });
  test('approved status cannot exist without an approver and timestamp', () => {
    const approval = { ...scope, approval_id: 'a', decision_id: 'd', decision_version: 1, action_hash: 'a'.repeat(64), policy_version: 'p1', expires_at: period.end };
    expect(ApprovalSchema.safeParse({ ...approval, resolution: { status: 'APPROVED' } }).success).toBe(false);
    expect(ApprovalSchema.safeParse({ ...approval, resolution: { status: 'APPROVED', approver_id: 'owner', approved_at: period.start } }).success).toBe(true);
  });
});
