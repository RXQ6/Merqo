import { z } from 'zod';
import type { SignalSnapshot } from './signals';
import type {RetailPagination} from './retail-query';

export const SignalPageSchema = z.strictObject({
  kind: z.enum(['inventory', 'ads']).optional(), source: z.enum(['demo', 'csv']).optional(),
  shop: z.string().max(120).optional(), channel: z.string().max(120).optional(), date: z.string().max(10).optional(),
  status: z.enum(['all', 'normal', 'warning', 'needs_evidence', 'anomalies']).default('all'),
  search: z.string().max(200).default(''), offset: z.number().int().min(0).max(200000).default(0),
  limit: z.number().int().min(1).max(200).default(30),
});
export type SignalPageInput = z.input<typeof SignalPageSchema>;
export interface SignalCounts { total: number; normal: number; warning: number; missing: number }
export interface SignalPagination {
  total: number; offset: number; limit: number;
  scopeEvidence?:RetailPagination['scopeEvidence'];
  /** Counts for the selected business scope, before search/status/page filtering. */
  summary: { inventory: SignalCounts; ads: SignalCounts };
  facets: { shops: string[]; channels: string[]; dates: string[] };
}
export interface SignalPage extends SignalSnapshot { pagination: SignalPagination }
